/**
 * Reference node behaviors — kernel test fixtures, not the shipped palette.
 *
 * The kernel is deliberately ignorant of what a "service" or a "cache" is: it
 * owns the clock, the event queue, routing, randomness and metrics, and calls
 * out to a `NodeBehavior` for everything domain-shaped. That seam needs *some*
 * behavior to be exercised against, and using the real five components (U3)
 * here would invert the dependency and make kernel tests fail for reasons that
 * belong to component semantics.
 *
 * So this is one deliberately dull behavior: a multi-server FIFO queue with
 * either fixed or exponential service, optional finite capacity, and optional
 * timeout-and-reissue. Enough to drive every kernel primitive, simple enough
 * that when a kernel test fails the kernel is what is wrong.
 *
 * Nothing imports this from `main.ts`, so it never reaches the bundle.
 */
import type { Job, NodeBehavior, NodeContext, NodeSnapshot } from "./kernel.ts";

export interface FixedService {
  kind: "fixed";
  time: number;
}

export interface ExponentialService {
  kind: "exponential";
  rate: number;
}

export interface ReferenceSpec extends Record<string, unknown> {
  service: FixedService | ExponentialService;
  /** Concurrent servers, c. Default 1. */
  servers?: number;
  /** Maximum jobs waiting (excluding those in service). Default unbounded. */
  capacity?: number;
  /** If set, a job admitted here that has not settled by then is reissued. */
  timeoutAfter?: number;
  /** Total attempts allowed per original job, including the first. Default 1. */
  maxAttempts?: number;
}

/**
 * A trace of behavior-visible moments, in the order the kernel delivered them.
 *
 * Used by the tie-break test: two events stamped at the same sim time have to
 * fire in a declared order, and the only way to observe that order from outside
 * is to have a behavior write down what it was told and when.
 */
export type Trace = string[];

export interface ReferenceOptions {
  trace?: Trace;
}

function readSpec(ctx: NodeContext): ReferenceSpec {
  return ctx.spec() as ReferenceSpec;
}

export function createReferenceNode(node: NodeSnapshot, options: ReferenceOptions = {}): NodeBehavior {
  const waiting: Job[] = [];
  const trace = options.trace;
  let busy = 0;

  const note = (what: string, ctx: NodeContext): void => {
    trace?.push(`${ctx.now().toFixed(6)} ${node.id} ${what}`);
  };

  const serviceTime = (ctx: NodeContext): number => {
    const { service } = readSpec(ctx);
    return service.kind === "fixed" ? service.time : ctx.random("service").nextExponential(service.rate);
  };

  // Hand-off, not call-and-wait: the reference node releases its server the
  // moment it forwards. Call semantics belong to the real components (U3); the
  // kernel tests want the dullest possible routing.
  const passOn = (job: Job, ctx: NodeContext): void => {
    const next = ctx.downstream()[0];
    if (next === undefined) {
      ctx.finish(job);
    } else {
      ctx.forward(next, job);
    }
  };

  const pump = (ctx: NodeContext): void => {
    const servers = readSpec(ctx).servers ?? 1;
    while (busy < servers && waiting.length > 0) {
      const job = waiting.shift();
      if (job === undefined) break;
      busy += 1;
      ctx.setQueueDepth(waiting.length);
      ctx.setBusy(busy);
      const duration = serviceTime(ctx);
      ctx.schedule(duration, () => {
        busy -= 1;
        ctx.setBusy(busy);
        note(`end:${job.id}`, ctx);
        passOn(job, ctx);
        pump(ctx);
      });
    }
  };

  return {
    accept(job, ctx) {
      const spec = readSpec(ctx);
      note(`accept:${job.id}`, ctx);

      const capacity = spec.capacity ?? Number.POSITIVE_INFINITY;
      if (waiting.length >= capacity) {
        ctx.drop(job, "overflow");
        return;
      }

      // Timeout-and-reissue is armed where the job entered the system, so a
      // reissue re-enters through the same arrival machinery that the load
      // generator uses — which is what makes retry amplification emergent
      // rather than a special case the kernel knows about.
      const maxAttempts = spec.maxAttempts ?? 1;
      if (spec.timeoutAfter !== undefined && job.attempt + 1 < maxAttempts) {
        ctx.schedule(spec.timeoutAfter, () => {
          if (!job.settled) {
            ctx.recordTimeout();
            ctx.recordRetry();
            ctx.reissue(job, 0);
          }
        });
      }

      waiting.push(job);
      ctx.setQueueDepth(waiting.length);
      pump(ctx);
    },

    onSpecChange(ctx) {
      note("spec-change", ctx);
      // A widened server count applies to work already waiting; work already in
      // service keeps the service time it was given. See kernel.ts on why
      // in-flight work is never retroactively rewritten.
      pump(ctx);
    },
  };
}

/** Registry shorthand: every node kind in a kernel test uses the reference behavior. */
export function referenceRegistry(options: ReferenceOptions = {}): Record<string, (node: NodeSnapshot) => NodeBehavior> {
  return {
    reference: (node) => createReferenceNode(node, options),
  };
}
