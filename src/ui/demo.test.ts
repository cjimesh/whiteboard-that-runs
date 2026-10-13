// @vitest-environment node
/**
 * The demo's own claims, checked against the demo.
 *
 * The arc F3 depends on is "boring and green, then dragged past capacity into a
 * collapse". The boring half was asserted nowhere, and it was false: the resting
 * load used to be 30/s, which holds for about a minute and then collapses with
 * nobody touching it. A demo that kills itself during its own preamble is worse
 * than one that never collapses, so the resting state is now a tested property.
 */
import { describe, expect, it } from "vitest";
import { createModelSimulation } from "../specs/registry.ts";
import { DEMO_BASE_RATE, DEMO_COLLAPSE_RATE, demoGuidance, demoTimeline, RETRY_PRESETS } from "./demo.ts";

/** Goodput over the trailing second of a run to `until`. */
function goodputAt(sim: ReturnType<typeof createModelSimulation>, until: number): number {
  sim.runUntil(until);
  const buckets = sim.series().slice(-20);
  return buckets.reduce((total, bucket) => total + bucket.system.completions, 0) / (buckets.length * 0.25);
}

describe("the resting load", () => {
  // Three seeds, because time-to-collapse is a random variable: a single seed
  // holding proves the demo got lucky, not that the load is inside the band.
  it.each(["demo-v1", "endurance-b", "endurance-c"])(
    "holds for 400 sim seconds on seed %s, unattended",
    (seed) => {
      const sim = createModelSimulation({
        ...demoTimeline(),
        seed,
        load: [{ rate: DEMO_BASE_RATE, duration: 3600 }],
      });

      for (let t = 50; t <= 400; t += 50) {
        expect(goodputAt(sim, t), `collapsed by t=${t}s`).toBeGreaterThan(DEMO_BASE_RATE * 0.5);
      }
    },
    60_000,
  );

  it("still collapses when driven past the band, or the demo has no arc", () => {
    const sim = createModelSimulation({
      ...demoTimeline(),
      load: [{ rate: DEMO_COLLAPSE_RATE, duration: 3600 }],
    });

    expect(goodputAt(sim, 90)).toBe(0);
  }, 60_000);
});

/**
 * The tour makes five claims about this model to somebody who has never seen it.
 * Each one is checked here against the model itself, because the last time this
 * demo was described in prose the prose was wrong for an entire build.
 */
describe("the tour tells the truth", () => {
  const guidance = demoGuidance();
  const model = demoTimeline().model;
  const spec = (id: string): Record<string, unknown> =>
    model.nodes.find((node) => node.id === id)?.spec as Record<string, unknown>;
  const said = guidance.steps.map((step) => `${step.action} ${step.watch}`).join(" ");

  it("sends the viewer to a rate the model does collapse at", () => {
    expect(said).toContain(`${DEMO_COLLAPSE_RATE}/s`);
  });

  it("quotes the datastore's real capacity", () => {
    const db = spec("orders-db") as { concurrency: number; service: { mean: number } };
    const perSecond = Math.round(db.concurrency / db.service.mean);

    // And the claim that matters is the relationship: the rate it asks for has to
    // be *under* capacity, or the collapse is just arithmetic and the demo has no
    // point to make.
    expect(said).toContain(`${perSecond} a second`);
    expect(DEMO_COLLAPSE_RATE).toBeLessThan(perSecond);
  });

  it("quotes the timeout and the retry count the model actually uses", () => {
    const api = spec("api-1") as { timeout: { after: number } };

    expect(said).toContain(`${Math.round(api.timeout.after * 1000)} ms`);
    expect(said).toContain(`${RETRY_PRESETS.backoff.attempts} retries`);
  });

  it("promises a recovery the model delivers, and no more than it delivers", () => {
    // Step four claims goodput comes back within seconds, "most of the way, not
    // all of it". Both halves are asserted: a tour that oversold the fix would be
    // contradicted on screen by the tool it is selling.
    const sim = createModelSimulation({
      ...demoTimeline(),
      load: [{ rate: DEMO_COLLAPSE_RATE, duration: 3600 }],
    });
    expect(goodputAt(sim, 60)).toBe(0);

    for (const id of ["api-1", "api-2"]) {
      sim.record({
        kind: "set-spec",
        nodeId: id,
        spec: { ...(spec(id) as object), retry: RETRY_PRESETS.none } as Record<string, unknown>,
      });
    }

    // Within seconds, and substantial.
    expect(goodputAt(sim, 66)).toBeGreaterThan(DEMO_COLLAPSE_RATE * 0.5);
    // Still short of the offered load a minute later: measured 27–42/s against 44
    // offered, because the timeout keeps clipping calls once the queue is deep.
    expect(goodputAt(sim, 120)).toBeLessThan(DEMO_COLLAPSE_RATE);
  }, 60_000);
});
