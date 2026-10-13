/**
 * A service: work arrives, waits, is served, and — if anything is wired
 * downstream — calls it and waits for the answer while still holding its thread.
 *
 * This is where retry amplification comes from (R6), and it comes from nowhere
 * special. The service is told its call timed out, its retry policy says try
 * again, so it issues another call. The abandoned attempt is still downstream
 * consuming capacity. Nothing here knows about death spirals; a spiral is what
 * this loop looks like when the parameters make it feed itself.
 */
import type { Job, NodeBehavior, NodeContext } from "../engine/kernel.ts";
import { createServerBehavior, passOn, type SpecReader } from "./server-core.ts";
import { backoff, maxAttempts } from "./retry.ts";

function callWithRetries(
  job: Job,
  ctx: NodeContext,
  read: SpecReader,
  target: string,
  release: () => void,
): void {
  const giveUpOrRetry = (attempt: number): void => {
    // Re-read here, not at entry: the whole point of a live mid-run policy change
    // is that a request already between attempts obeys the new rule.
    const spec = read();
    if (attempt + 1 >= maxAttempts(spec.retry)) {
      release();
      ctx.drop(job, "downstream did not answer");
      return;
    }
    ctx.recordRetry();
    const wait = backoff(spec.retry, attempt + 1);
    if (wait > 0) {
      // The server stays occupied across the backoff — a thread sleeping before
      // it retries is not a thread available for new work.
      ctx.schedule(wait, () => attemptCall(attempt + 1));
    } else {
      attemptCall(attempt + 1);
    }
  };

  const attemptCall = (attempt: number): void => {
    const handle = ctx.call(
      target,
      job,
      (outcome) => {
        if (outcome === "ok") {
          release();
          ctx.finish(job);
        } else {
          giveUpOrRetry(attempt);
        }
      },
      attempt,
    );

    const { timeout } = read();
    if (timeout.policy === "fixed") {
      ctx.schedule(timeout.after, () => {
        if (handle.closed) return;
        handle.abandon();
        ctx.recordTimeout();
        giveUpOrRetry(attempt);
      });
    }
  };

  attemptCall(0);
}

export function createService(): NodeBehavior {
  return createServerBehavior("service", (job, ctx, read, release) => {
    const target = ctx.downstream()[0];
    if (target === undefined) {
      passOn(job, ctx, release, undefined);
      return;
    }

    if (read().downstream.policy === "fire-and-forget") {
      passOn(job, ctx, release, target);
      return;
    }

    callWithRetries(job, ctx, read, target, release);
  });
}
