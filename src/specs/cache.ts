/**
 * A cache: a stated hit ratio in front of an origin.
 *
 * A hit is served here and done. A miss calls downstream and waits, holding its
 * slot — so a cache in front of a slow datastore correctly stops shielding it
 * once the miss rate rises, which is the dynamic worth watching.
 *
 * `fixed-ratio` is a declared ratio, not a modelled key space. That is a real
 * limitation and it is the honest one for this tool: the product claims correct
 * consequences of stated inputs, and "what my hit ratio would be" is an input
 * the author brings, not something a simulator should invent for them.
 */
import type { NodeBehavior } from "../engine/kernel.ts";
import { callAndSettle, createServerBehavior, passOn } from "./server-core.ts";

export function createCache(): NodeBehavior {
  return createServerBehavior("cache", (job, ctx, read, release) => {
    const spec = read();
    const hit = ctx.random("cache").nextUnit() < spec.cache.hitRatio;

    if (hit) {
      release();
      ctx.finish(job);
      return;
    }

    const origin = ctx.downstream()[0];
    if (origin === undefined) {
      release();
      ctx.drop(job, "cache miss with no origin behind it");
      return;
    }

    if (spec.downstream.policy === "fire-and-forget") {
      passOn(job, ctx, release, origin);
      return;
    }

    callAndSettle(job, ctx, release, origin, "origin did not answer the cache fill");
  });
}
