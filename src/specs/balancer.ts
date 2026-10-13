/**
 * A load balancer: picks one of its outgoing edges and hands the work over.
 *
 * It is the one component with no server and no buffer. A balancer that queued
 * would be a service, and modelling its own capacity would put a bottleneck in
 * the picture that the author did not draw. Work passes through in zero sim time,
 * so a balancer never hides latency it did not cause.
 *
 * `least-queue` reads the live queue depth its targets report. Ties resolve to
 * the first edge in model order rather than randomly — a balancer that shuffled
 * on ties would make two runs of the same timeline diverge.
 */
import type { NodeBehavior } from "../engine/kernel.ts";
import { resolveSpecStrict } from "./format.ts";

export function createBalancer(): NodeBehavior {
  let cursor = 0;

  return {
    accept(job, ctx) {
      const targets = ctx.downstream();
      if (targets.length === 0) {
        ctx.drop(job, "load balancer has nothing behind it");
        return;
      }

      const spec = resolveSpecStrict("balancer", ctx.spec(), ctx.id);
      let chosen: string;

      switch (spec.balancer.policy) {
        case "round-robin": {
          chosen = targets[cursor % targets.length] as string;
          cursor += 1;
          break;
        }
        case "random": {
          const draw = ctx.random("balance").nextUnit();
          chosen = targets[Math.min(targets.length - 1, Math.floor(draw * targets.length))] as string;
          break;
        }
        case "least-queue": {
          let best = targets[0] as string;
          let bestDepth = ctx.queueDepthOf(best);
          for (const target of targets.slice(1)) {
            const depth = ctx.queueDepthOf(target);
            if (depth < bestDepth) {
              best = target;
              bestDepth = depth;
            }
          }
          chosen = best;
          break;
        }
      }

      ctx.forward(chosen, job);
    },
  };
}
