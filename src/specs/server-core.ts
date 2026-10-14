/**
 * The shared server: a buffer with a queue discipline, some number of servers,
 * and a service time. Four of the five components are this plus a decision about
 * what to do with a job once it has been served.
 *
 * That sharing is deliberate and worth being honest about: a service, a queue, a
 * cache and a datastore are not four different queueing mechanisms. They are one
 * mechanism with different concern sets, different defaults, and different
 * after-service behavior — which is exactly the claim the spec format makes. Four
 * copies of the same pump would mean four places for the admission rule to drift.
 *
 * The spec is re-read at every decision rather than captured once. That is what
 * makes a mid-run policy change reach work that is already in flight: flip retry
 * to `capped` while a request is between attempts and the *next* attempt honours
 * it. Capturing the spec at service-start would mean every request already in a
 * retry loop kept amplifying under the old policy, and the recovery the room is
 * watching for would arrive late and look unconvincing.
 */
import type { Job, NodeBehavior, NodeContext } from "../engine/kernel.ts";
import { resolveSpecStrict, type ComponentKind, type ComponentSpec } from "./format.ts";
import { resolveCallPolicyStrict, type CallPolicy } from "./call-policy.ts";
import { backoff, createRetryBudget, earnRetry, maxAttempts, spendRetry, type RetryBudget } from "./retry.ts";

/** Reads the node's spec, resolved against defaults and cached until it changes. */
export type SpecReader = () => ComponentSpec;

export interface ServedHandler {
  (job: Job, ctx: NodeContext, read: SpecReader, release: () => void): void;
}

function drawServiceTime(ctx: NodeContext, spec: ComponentSpec): number {
  const { policy, mean } = spec.service;
  if (mean <= 0) return 0;
  return policy === "fixed" ? mean : ctx.random("service").nextExponential(1 / mean);
}

/**
 * How long the slot itself is taken, when that is not the service time.
 *
 * `null` when the component has no hold, which keeps the ordinary path exactly
 * as it was rather than routing it through a lease of length zero.
 *
 * Its own random substream, so adding a hold to one component does not shift the
 * service times drawn by any other — the common-random-numbers property the
 * delta toggle's warrant rests on.
 */
function drawHold(ctx: NodeContext, spec: ComponentSpec): number | null {
  const { policy, mean } = spec.hold;
  if (policy === "none" || mean <= 0) return null;
  return policy === "fixed" ? mean : ctx.random("hold").nextExponential(1 / mean);
}

/**
 * A call's policy, resolved once per authored object.
 *
 * Keyed by identity because the kernel replaces a dependency's policy object on
 * every `set-call` and never edits one in place, so a changed policy is a cache
 * miss by construction. Resolving per call would be correct, but a model that
 * asks Redis eighty times a request would validate the same object eighty times.
 */
const resolvedPolicies = new WeakMap<object, CallPolicy>();

function policyOf(ctx: NodeContext, target: string): CallPolicy {
  const raw = ctx.dependencies().find((dependency) => dependency.id === target)?.policy ?? {};
  let policy = resolvedPolicies.get(raw);
  if (policy === undefined) {
    policy = resolveCallPolicyStrict(raw, `the call "${ctx.id}" → "${target}"`);
    resolvedPolicies.set(raw, policy);
  }
  return policy;
}

/**
 * Ask every dependency, in order, and only then carry on.
 *
 * Sequential rather than concurrent, and that is a narrowing worth stating: a
 * component that fired twenty Redis calls in parallel would occupy the shared
 * server twenty times over at one instant, and nothing in the vocabulary yet says
 * whether a caller does that or waits between each. One at a time is the
 * conservative reading and the common one.
 *
 * The caller's slot stays taken throughout — that is what makes a shared
 * dependency's slowness show up as saturation in everything that leans on it,
 * which is the whole reason for drawing it once instead of folding its latency
 * into each caller's own service time.
 *
 * Each call obeys its own edge's timeout and retry (`call-policy.ts`), and a
 * call that runs out of tries fails the request here, by name. A timed-out
 * attempt is abandoned, not cancelled: it stays at the dependency, queued or
 * being served, while the retry joins the queue behind it. Nothing here knows
 * about retry storms; that is what this loop does to a dependency already near
 * its knee. The caller holds its slot across a backoff, as a service does — a
 * thread sleeping before it asks again is not a thread free for new work.
 */
function askDependencies(
  job: Job,
  ctx: NodeContext,
  onDone: () => void,
  onFail: (target: string) => void,
  budgets: Map<string, RetryBudget>,
): void {
  const deps = ctx.dependencies();
  const budgetFor = (target: string): RetryBudget => {
    let budget = budgets.get(target);
    if (budget === undefined) {
      budget = createRetryBudget();
      budgets.set(target, budget);
    }
    return budget;
  };
  if (deps.length === 0) {
    onDone();
    return;
  }

  const calls: string[] = [];
  for (const dep of deps) {
    for (let i = 0; i < dep.times; i += 1) calls.push(dep.id);
  }

  let index = 0;
  const step = (): void => {
    if (index >= calls.length) {
      onDone();
      return;
    }
    const target = calls[index] as string;
    index += 1;
    earnRetry(budgetFor(target), policyOf(ctx, target).retry);
    attempt(target, 0);
  };

  const giveUpOrRetry = (target: string, tried: number): void => {
    // Re-read here, not when the call began: a live change to the policy
    // reaches a request that is already between attempts.
    const { retry } = policyOf(ctx, target);
    if (tried + 1 >= maxAttempts(retry) || !spendRetry(budgetFor(target), retry)) {
      onFail(target);
      return;
    }
    ctx.recordRetry();
    const wait = backoff(retry, tried + 1);
    if (wait > 0) ctx.schedule(wait, () => attempt(target, tried + 1));
    else attempt(target, tried + 1);
  };

  const attempt = (target: string, tried: number): void => {
    const handle = ctx.call(
      target,
      job,
      (outcome) => {
        if (outcome === "ok") step();
        else giveUpOrRetry(target, tried);
      },
      tried,
    );

    const { timeout } = policyOf(ctx, target);
    if (timeout.policy === "fixed") {
      ctx.schedule(timeout.after, () => {
        if (handle.closed) return;
        handle.abandon();
        ctx.recordTimeout();
        giveUpOrRetry(target, tried);
      });
    }
  };

  step();
}

/**
 * Where a job goes in the wait buffer, and what gets thrown away if it is full.
 *
 * Returns the job to reject, or `null` if everything fits. Priority ordering is
 * by attempt number — a first try outranks a retry — and overflow sheds the
 * lowest-ranked item, which may well be the arrival itself.
 */
export function admitJob(waiting: Job[], job: Job, spec: ComponentSpec): Job | null {
  const { policy, capacity } = spec.queue;
  const full = waiting.length >= capacity;

  if (policy === "priority") {
    // Stable insert: ahead of the first job with a strictly higher attempt.
    let index = waiting.length;
    for (let i = 0; i < waiting.length; i += 1) {
      if ((waiting[i] as Job).attempt > job.attempt) {
        index = i;
        break;
      }
    }
    waiting.splice(index, 0, job);
    if (waiting.length > capacity) {
      return waiting.pop() ?? null;
    }
    return null;
  }

  if (full) {
    if (policy === "drop-oldest") {
      const evicted = waiting.shift() ?? null;
      waiting.push(job);
      return evicted;
    }
    return job; // fifo: tail drop, refuse the newcomer
  }

  waiting.push(job);
  return null;
}

/**
 * Hand the job on and stop holding it — or finish it, if this is the last stop.
 *
 * The fire-and-forget and pass-through ending, shared by everything that does
 * not wait for an answer.
 */
export function passOn(job: Job, ctx: NodeContext, release: () => void, target: string | undefined): void {
  release();
  if (target === undefined) {
    ctx.finish(job);
  } else {
    ctx.forward(target, job);
  }
}

/**
 * Call downstream and keep holding this server until it answers, then settle.
 *
 * The plain call-and-wait ending, for components with no retry policy of their
 * own. A service has one, so it does not use this.
 */
export function callAndSettle(
  job: Job,
  ctx: NodeContext,
  release: () => void,
  target: string,
  failureReason: string,
): void {
  ctx.call(target, job, (outcome) => {
    release();
    if (outcome === "ok") {
      ctx.finish(job);
    } else {
      ctx.drop(job, failureReason);
    }
  });
}

export function createServerBehavior(kind: ComponentKind, served: ServedHandler): NodeBehavior {
  const waiting: Job[] = [];
  let busy = 0;
  let cached: ComponentSpec | null = null;
  // One retry budget per dependency: a budget on the call to Redis says nothing
  // about the call to the database.
  const budgets = new Map<string, RetryBudget>();

  // Resolving on every read would be correct but wasteful at sweep scale, so the
  // result is cached and thrown away whenever a mutation lands on this node.
  const readFor =
    (ctx: NodeContext): SpecReader =>
    () => {
      cached ??= resolveSpecStrict(kind, ctx.spec(), ctx.id);
      return cached;
    };

  const pump = (ctx: NodeContext, read: SpecReader): void => {
    for (;;) {
      const spec = read();
      if (busy >= spec.concurrency || waiting.length === 0) break;
      const job = waiting.shift();
      if (job === undefined) break;

      busy += 1;
      ctx.setQueueDepth(waiting.length);
      ctx.setBusy(busy, spec.concurrency);

      let released = false;
      const freeSlot = (): void => {
        // Guarded because a handler can be told about the same call twice — a
        // late reply arriving after a timeout already gave up, for instance —
        // and freeing one server twice would manufacture capacity.
        if (released) return;
        released = true;
        busy -= 1;
        ctx.setBusy(busy, read().concurrency);
        pump(ctx, read);
      };

      const hold = drawHold(ctx, spec);
      const service = drawServiceTime(ctx, spec);

      // Its own work first, then whatever it leans on, then the handler decides
      // where the job goes. A failed dependency ends the request here rather than
      // travelling on as if it had succeeded.
      const proceed = (release: () => void): void =>
        askDependencies(
          job,
          ctx,
          () => served(job, ctx, read, release),
          (target) => {
            release();
            ctx.drop(job, `${target} did not answer`);
          },
          budgets,
        );

      if (hold === null) {
        ctx.schedule(service, () => proceed(freeSlot));
        continue;
      }

      // A lease. The slot comes back on its own clock, so what the handler is
      // given is a release that settles the caller and frees nothing — the
      // request leaves, the resource does not. Answering happens at whichever
      // comes first, so a hold shorter than the service time degenerates
      // harmlessly instead of promising an answer after the slot is gone.
      ctx.schedule(hold, freeSlot);
      ctx.schedule(Math.min(service, hold), () => proceed(() => undefined));
    }
  };

  return {
    accept(job, ctx) {
      const read = readFor(ctx);
      const spec = read();

      // `capacity` bounds how much work may *wait*, not how much may pass
      // through. An idle server takes the arrival directly — otherwise capacity
      // 0 would mean "reject everything" rather than "never queue", and a
      // no-buffer loss system is a perfectly ordinary thing to want to model.
      // The pump leaves `busy < concurrency` only when nothing is waiting, so
      // this branch never jumps a queue.
      if (busy < spec.concurrency) {
        waiting.push(job);
        ctx.setQueueDepth(waiting.length);
        pump(ctx, read);
        return;
      }

      const rejected = admitJob(waiting, job, spec);
      ctx.setQueueDepth(waiting.length);

      if (rejected !== null) {
        ctx.drop(rejected, "buffer full");
        // A shed job is gone, but the pump still owes work to whatever remains.
      }
      pump(ctx, read);
    },

    onSpecChange(ctx) {
      cached = null;
      const read = readFor(ctx);
      // A widened pool applies to work already waiting. Work already in service
      // keeps the service time it was given — the kernel's tie-break rule is
      // that a change never rewrites the past.
      ctx.setBusy(busy, read().concurrency);
      pump(ctx, read);
    },
  };
}
