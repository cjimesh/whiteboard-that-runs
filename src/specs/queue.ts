/**
 * A queue: a buffer with consumers.
 *
 * `concurrency` is how many consumers work at once, `service` is how long one
 * takes, and `capacity` is how deep the backlog is allowed to get. It defaults
 * to fire-and-forget because a producer dropping a message and walking away is
 * the normal shape; `call-and-wait` is there for a consumer that acknowledges.
 *
 * It carries no timeout or retry concerns. A broker does not retry on its
 * consumer's behalf, and offering the setting would invite an author to model
 * a mitigation that does not exist in their system.
 */
import type { NodeBehavior } from "../engine/kernel.ts";
import { callAndSettle, createServerBehavior, passOn } from "./server-core.ts";

export function createQueue(): NodeBehavior {
  return createServerBehavior("queue", (job, ctx, read, release) => {
    const target = ctx.downstream()[0];

    if (target === undefined || read().downstream.policy === "fire-and-forget") {
      passOn(job, ctx, release, target);
      return;
    }

    callAndSettle(job, ctx, release, target, "consumer rejected the message");
  });
}
