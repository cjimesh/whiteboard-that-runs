/**
 * The detector, tested from both sides.
 *
 * A detector is only worth something if it is wrong in neither direction, and the
 * two failures are not symmetric. Firing on a healthy design makes the tool cry
 * wolf and it stops being believed; missing a real collapse makes it endorse a
 * system that falls over. So the false-positive side is pinned against real
 * simulations of queues that are provably stable right up to ρ = 0.95, and the
 * false-negative side against overload and against a retry storm — which fails in
 * a completely different shape, losing everything while the queue stays bounded.
 */
import { describe, expect, it } from "vitest";
import { detect, signalsFor, trend, DETECTOR } from "./instability.ts";
import type { BucketSample, NodeBucket, SystemBucket } from "../engine/metrics.ts";
import type { Timeline } from "../engine/timeline.ts";
import { createModelSimulation } from "../specs/registry.ts";

const WARM = 20;
const MEASURE = 120;

function node(overrides: Partial<NodeBucket> = {}): NodeBucket {
  return {
    arrivals: 0,
    departures: 0,
    drops: 0,
    wasted: 0,
    timeouts: 0,
    retries: 0,
    sojournMean: 0,
    sojournP50: 0,
    sojournP95: 0,
    sojournP99: 0,
    residentMean: 0,
    queueDepthMean: 0,
    queueDepthEnd: 0,
    utilization: 0,
    ...overrides,
  };
}

function system(overrides: Partial<SystemBucket> = {}): SystemBucket {
  return {
    arrivals: 0,
    completions: 0,
    drops: 0,
    latencyMean: 0,
    latencyP50: 0,
    latencyP95: 0,
    latencyP99: 0,
    inFlightEnd: 0,
    ...overrides,
  };
}

/** `inFlight[i]` is the work resident at the end of second `i`. */
function buckets(inFlight: readonly number[], per: Partial<SystemBucket> = {}): BucketSample[] {
  return inFlight.map((value, index) => ({
    start: index,
    end: index + 1,
    nodes: { only: node({ utilization: 0.5 }) },
    sources: {},
    system: system({ ...per, inFlightEnd: value }),
  }));
}

/** A single queue at a declared utilization, run headless and measured. */
function runQueue(lambda: number, mu: number, seed: string): BucketSample[] {
  const timeline: Timeline = {
    model: {
      entryId: "node",
      nodes: [
        {
          id: "node",
          kind: "service",
          spec: {
            concurrency: 1,
            service: { policy: "exponential", mean: 1 / mu },
            queue: { policy: "fifo", capacity: 10_000_000 },
            timeout: { policy: "none", after: 1 },
            retry: { policy: "none", attempts: 0, delay: 0, factor: 2, maxDelay: 1 },
          },
        },
      ],
      edges: [],
    },
    load: [{ rate: lambda, duration: WARM + MEASURE }],
    seed,
    mutations: [],
    bucketWidth: 1,
  };

  const sim = createModelSimulation(timeline);
  sim.runUntil(WARM + MEASURE);
  return sim.series().filter((bucket) => bucket.start >= WARM);
}

describe("trend", () => {
  it("measures the slope of a rising series, per second", () => {
    expect(trend(buckets([0, 2, 4, 6, 8]), (bucket) => bucket.system.inFlightEnd)).toBeCloseTo(2, 6);
  });

  it("reads a flat series as no trend, however noisy", () => {
    const noisy = buckets([3, 9, 1, 8, 2, 7, 3, 8, 2, 9, 1, 7]);
    expect(Math.abs(trend(noisy, (bucket) => bucket.system.inFlightEnd))).toBeLessThan(0.2);
  });

  it("returns zero rather than dividing by nothing on a single bucket", () => {
    expect(trend(buckets([5]), (bucket) => bucket.system.inFlightEnd)).toBe(0);
  });
});

describe("signals", () => {
  it("charges the deficit against arrivals actually admitted, not the nominal rate", () => {
    // 90 of 100 completed. The nominal rate is deliberately wrong: a Poisson
    // stream over a finite window does not deliver exactly its mean, and charging
    // that difference to the design would make the verdict depend on the seed.
    const series = buckets([0, 0], { arrivals: 50, completions: 45 });
    const signals = signalsFor(series, 999);

    expect(signals.deficit).toBeCloseTo(0.1, 6);
  });

  it("reports the busiest component's mean utilization, not its highest second", () => {
    const series: BucketSample[] = [
      { start: 0, end: 1, nodes: { a: node({ utilization: 1 }), b: node({ utilization: 0.2 }) }, sources: {}, system: system() },
      { start: 1, end: 2, nodes: { a: node({ utilization: 0 }), b: node({ utilization: 0.2 }) }, sources: {}, system: system() },
    ];

    // A single saturated second happens at half load, so a peak would report
    // every design as saturated and mean nothing.
    expect(signalsFor(series, 10).busiest).toBeCloseTo(0.5, 6);
  });
});

describe("detecting a fold", () => {
  it("does not fire on a stable queue, at any utilization up to 0.95", () => {
    for (const lambda of [25, 40, 45, 47.5]) {
      for (const seed of ["s1", "s2", "s3"]) {
        const verdict = detect(runQueue(lambda, 50, seed), lambda);
        expect(verdict.holds, `λ=${lambda} seed=${seed}: ${verdict.reason}`).toBe(true);
      }
    }
  });

  it("fires on every seed once the queue is genuinely overloaded", () => {
    for (const seed of ["s1", "s2", "s3"]) {
      const verdict = detect(runQueue(51, 50, seed), 51);
      expect(verdict.holds, `seed=${seed}: ${verdict.reason}`).toBe(false);
    }
  });

  it("names growth as the cause when an unbounded queue piles up", () => {
    const verdict = detect(runQueue(60, 50, "s1"), 60);

    expect(verdict.cause).toBe("both");
    expect(verdict.signals.growth).toBeGreaterThan(5);
    expect(verdict.reason).toContain("grew by");
  });

  it("fires on loss alone, which is how a bounded queue and a retry storm fail", () => {
    // Nothing piles up — everything offered is being thrown away instead. A
    // detector that only watched queue growth would call this healthy.
    const series = buckets([4, 4, 4, 4, 4, 4], { arrivals: 40, completions: 0 });
    const verdict = detect(series, 40);

    expect(verdict.holds).toBe(false);
    expect(verdict.cause).toBe("loss");
    expect(verdict.reason).toContain("never completed");
  });

  it("does not fire on a spike that drains inside the window", () => {
    // Work climbs to 30 and comes back down. Occupancy ends where it started and
    // everything offered completed, so this is a transient, not an instability.
    const series = buckets(
      [2, 8, 18, 30, 24, 12, 5, 2, 2, 2, 2, 2],
      { arrivals: 20, completions: 20 },
    );
    const verdict = detect(series, 20);

    expect(verdict.holds, verdict.reason).toBe(true);
  });

  it("holds when both signals sit just inside their thresholds", () => {
    // Boundary case, written against the constants rather than against numbers
    // that happen to pass, so moving a threshold moves this test with it.
    const offered = 100;
    const growthPerSecond = DETECTOR.growth * offered * 0.9;
    const series = buckets(
      Array.from({ length: 20 }, (_, index) => index * growthPerSecond),
      { arrivals: 1000, completions: Math.ceil(1000 * (1 - DETECTOR.deficit * 0.9)) },
    );

    expect(detect(series, offered).holds).toBe(true);
  });
});
