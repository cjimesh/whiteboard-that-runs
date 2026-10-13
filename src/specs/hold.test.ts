// @vitest-environment node
/**
 * The lease: a slot that stays taken after the request has been answered.
 *
 * The concern exists because of a real system. Its session pool is claimed by
 * one request, answered in a couple of seconds, and released a minute or more
 * later by a *different* request. Drawn without a lease that pool reads as
 * nearly idle while it is the only thing that binds, and the tool names the
 * wrong component as the bottleneck.
 *
 * What is asserted here is the claim the whole concern rests on: **a lease is an
 * M/M/c server whose service time is the hold**, with the caller let go early. If
 * that is true then the closed forms already in the validation suite apply to it,
 * and the capacity a room is told about is the capacity the model runs at.
 */
import { describe, expect, it } from "vitest";
import { createModelSimulation } from "./registry.ts";
import { capacityOf, describeCapacity, withCapacity } from "./capacity.ts";
import { resolveSpec, validateSpec } from "./format.ts";
import type { Timeline } from "../engine/timeline.ts";

function pool(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    concurrency: 4,
    service: { policy: "fixed", mean: 0.1 },
    queue: { policy: "fifo", capacity: 10_000 },
    ...overrides,
  };
}

function run(spec: Record<string, unknown>, rate: number, seconds: number) {
  const timeline: Timeline = {
    model: { entryId: "pool", nodes: [{ id: "pool", kind: "datastore", spec }], edges: [] },
    load: [{ rate, duration: seconds }],
    seed: "hold-test",
    mutations: [],
    bucketWidth: 1,
  };
  const sim = createModelSimulation(timeline);
  sim.runUntil(seconds);

  const window = sim.series().filter((bucket) => bucket.start >= seconds * 0.25);
  const completions = window.reduce((total, b) => total + b.system.completions, 0);
  return {
    throughput: completions / window.length,
    latency: window.reduce((t, b) => t + b.system.latencyMean * b.system.completions, 0) / (completions || 1),
    utilization: window.reduce((t, b) => t + (b.nodes["pool"]?.utilization ?? 0), 0) / window.length,
  };
}

describe("what a hold does to the engine", () => {
  it("lets the caller go at the service time and keeps the slot for the hold", () => {
    // Deliberately far from saturation — λ × hold / c = 0.5 × 2 / 4 = 0.25 — so
    // that almost nobody waits to acquire and the latency is the answer time
    // alone. Nearer the ceiling a caller waits for a slot as well, which is the
    // Erlang C queue the validation suite checks; here the claim under test is
    // narrower: the caller leaves while the slot stays taken.
    const leased = run(pool({ hold: { policy: "fixed", mean: 2 } }), 0.5, 600);

    // The claim, stated as the ratio it is about: the caller is gone in a
    // twentieth of the time the slot stays taken. (Not exactly 100 ms — even at
    // a quarter load a few arrivals find all four slots held.)
    expect(leased.latency).toBeLessThan(0.15);
    expect(leased.latency).toBeLessThan(2 / 10);
    expect(leased.utilization).toBeCloseTo(0.25, 1);
    // Everything offered is served — the lease costs capacity, not requests, and
    // at a quarter load there is plenty to spare.
    expect(leased.throughput).toBeGreaterThan(0.4);
  });

  it("bounds throughput by the hold, not by the work", () => {
    // Offered well past 4/2 = 2 a second. Without the lease this pool would serve
    // 40/s, because the work itself only takes 100 ms.
    const leased = run(pool({ hold: { policy: "fixed", mean: 2 }, queue: { policy: "fifo", capacity: 0 } }), 20, 600);

    expect(leased.throughput).toBeLessThan(2.2);
    // Not quite 1: with no buffer a freed slot sits idle until the next arrival
    // turns up, which at 20/s is about 50 ms against a 2 s hold.
    expect(leased.utilization).toBeGreaterThan(0.95);
  });

  it("changes nothing at all when the policy is none", () => {
    // The ordinary path has to stay the ordinary path: same seed, same draws,
    // same numbers to the last digit, or every model built before this concern
    // existed would quietly move.
    const without = run(pool(), 20, 400);
    const explicitNone = run(pool({ hold: { policy: "none", mean: 60 } }), 20, 400);

    expect(explicitNone).toEqual(without);
  });

  it("degenerates harmlessly when the hold is shorter than the work", () => {
    // Incoherent to author, and it must not promise an answer after the slot has
    // already gone back. The caller is answered when the slot frees.
    const odd = run(pool({ service: { policy: "fixed", mean: 5 }, hold: { policy: "fixed", mean: 0.5 } }), 2, 400);

    expect(odd.latency).toBeLessThanOrEqual(0.55);
  });

  it("draws the hold from its own random stream", () => {
    // Adding a lease to one component must not shift the service times drawn by
    // another, or the delta toggle stops comparing like with like.
    const sim = createModelSimulation({
      model: {
        entryId: "front",
        nodes: [
          { id: "front", kind: "service", spec: pool({ concurrency: 100 }) },
          { id: "back", kind: "datastore", spec: pool({ hold: { policy: "exponential", mean: 2 } }) },
        ],
        edges: [{ from: "front", to: "back" }],
      },
      load: [{ rate: 1, duration: 100 }],
      seed: "streams",
      mutations: [],
      bucketWidth: 1,
    });
    sim.runUntil(100);

    expect(sim.drawCount("back", "hold")).toBeGreaterThan(0);
    expect(sim.drawCount("front", "hold")).toBe(0);
  });
});

describe("what a hold does to the capacity a room is told", () => {
  it("reads capacity off the hold, because that is what bounds throughput", () => {
    const reading = capacityOf("datastore", pool({ hold: { policy: "exponential", mean: 2 } }) as never);

    expect(reading?.perSecond).toBeCloseTo(2, 6);
    expect(reading?.leased).toBe(true);
    // Not 4 / 0.1 = 40/s, which is what the work alone would say.
  });

  it("says the rate comes from a lease, not from the work", () => {
    const reading = capacityOf("datastore", pool({ hold: { policy: "exponential", mean: 2 } }) as never);

    expect(describeCapacity(reading as never)).toContain("held for 2 s");
  });

  it("edits the hold when a leased component's capacity is set", () => {
    // Writing to the service time here would leave the panel reading 2/s while
    // the model ran at 40 — the confusion the concern exists to end.
    const updated = withCapacity("datastore", pool({ hold: { policy: "exponential", mean: 2 } }) as never, 8);
    const resolved = resolveSpec("datastore", updated);

    expect(resolved.hold.mean).toBeCloseTo(0.5, 6);
    expect(resolved.service.mean).toBeCloseTo(0.1, 6);
  });

  it("still edits the service time when there is no lease", () => {
    const updated = withCapacity("datastore", pool() as never, 8);
    const resolved = resolveSpec("datastore", updated);

    expect(resolved.service.mean).toBeCloseTo(0.5, 6);
  });
});

describe("what may be authored", () => {
  it("refuses a hold that is not a positive duration", () => {
    const result = validateSpec("datastore", { hold: { policy: "fixed", mean: 0 } });

    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toMatch(/positive number of seconds/);
  });

  it("refuses a policy outside the enum", () => {
    const result = validateSpec("datastore", { hold: { policy: "forever", mean: 1 } });

    expect(result.ok).toBe(false);
  });

  it("refuses a hold on a balancer, which has no slot to hold", () => {
    const result = validateSpec("balancer", { hold: { policy: "fixed", mean: 1 } }, { strictConcerns: true });

    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toMatch(/does not use "hold"/);
  });
});
