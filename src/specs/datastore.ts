/**
 * A datastore: a connection pool in front of stored work.
 *
 * `concurrency` is the pool size and `capacity` is how many callers may queue for
 * a connection — so a full buffer here reads as "pool exhausted, connection
 * refused", which is the failure a review room recognises. Mechanically it is the
 * shared server with no downstream concerns, because a datastore is where a
 * request stops.
 *
 * If one is wired onward anyway, the job is forwarded rather than quietly
 * finished. A silently ignored edge is a model that disagrees with the picture
 * the room is looking at.
 */
import type { NodeBehavior } from "../engine/kernel.ts";
import { createServerBehavior, passOn } from "./server-core.ts";

export function createDatastore(): NodeBehavior {
  return createServerBehavior("datastore", (job, ctx, _read, release) => {
    passOn(job, ctx, release, ctx.downstream()[0]);
  });
}
