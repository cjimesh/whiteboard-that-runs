/**
 * The sweep, against a queue whose breaking point is known from theory and
 * against a design whose breaking point genuinely is not a number.
 *
 * An M/M/1 queue stops keeping up at λ = μ, exactly, and that is the one place in
 * this palette where the right answer can be written down in advance — so it is
 * where the search itself gets checked. Everything after that tests the shapes of
 * answer that are not a breaking point, because those are the ones an
 * instrument is tempted to paper over.
 */
import { describe, expect, it } from "vitest";
import { sweep, SWEEP_BUDGET, type SweepBudget, type SweepTarget } from "./sweep.ts";
import { demoTimeline, DEMO_BASE_RATE } from "../ui/demo.ts";
import type { ModelSnapshot } from "../engine/timeline.ts";

/** Shorter windows than the shipped budget; the M/M/1 band is the same at both. */
const FAST: SweepBudget = { ...SWEEP_BUDGET, warmUpSeconds: 10, measureSeconds: 120 };

const MU = 50;

function queueModel(mu = MU): ModelSnapshot {
  return {
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
  };
}

function queueTarget(baseRate: number, seed = "sweep-test"): SweepTarget {
  return { model: queueModel(), seed, baseRate };
}

describe("bracketing a known breaking point", () => {
  it("brackets λ = μ on an M/M/1 queue", () => {
    const result = sweep(queueTarget(25), { budget: FAST });

    expect(result.holds).not.toBeNull();
    expect(result.folds).not.toBeNull();
    // The bracket has to contain the theoretical breaking point, allowing for the
    // detector's measured discrimination band around it (ρ = 0.97 to 1.01).
    expect(result.holds as number).toBeLessThanOrEqual(MU * 1.01);
    expect(result.folds as number).toBeGreaterThanOrEqual(MU * 0.97);
  });

  it("reports a bracket, never a point", () => {
    const result = sweep(queueTarget(25), { budget: FAST });

    expect(result.folds as number).toBeGreaterThan(result.holds as number);
  });

  it("stops at the declared resolution instead of bisecting into noise", () => {
    const result = sweep(queueTarget(25), { budget: FAST });
    const holds = result.holds as number;
    const folds = result.folds as number;

    expect((folds - holds) / folds).toBeLessThanOrEqual(FAST.resolution);
    // And it stopped at the first opportunity rather than spending probes it did
    // not need: one more halving would have been well inside the resolution.
    expect((folds - holds) / folds).toBeGreaterThan(FAST.resolution / 4);
  });

  it("never spends more than its declared probe budget", () => {
    const budget: SweepBudget = { ...FAST, maxProbes: 4 };
    const result = sweep(queueTarget(25), { budget });

    expect(result.probes.length).toBeLessThanOrEqual(budget.maxProbes);
  });

  it("reports every probe as it lands, so a panel can fill in rather than hang", () => {
    const seen: number[] = [];
    const result = sweep(queueTarget(25), { budget: FAST, onProbe: (probe) => seen.push(probe.rate) });

    // Every search probe plus the confirmation.
    expect(seen).toEqual([...result.probes.map((probe) => probe.rate), result.confirmation?.rate]);
  });
});

describe("the answers that are not a breaking point", () => {
  it("says how far it searched when nothing folds", () => {
    // A ceiling of 8 × 0.5/s is nowhere near a 50/s queue.
    const result = sweep(queueTarget(0.5), { budget: FAST });

    expect(result.folds).toBeNull();
    expect(result.holds).not.toBeNull();
    expect(result.ceiling).toBeCloseTo(0.5 * FAST.ceilingMultiple, 6);
  });

  it("says so when even the floor of the search is already folding", () => {
    // Every rate searched, down to 500/8, is past a 50/s queue.
    const result = sweep(queueTarget(500), { budget: FAST });

    expect(result.holds).toBeNull();
    expect(result.folds).toBeCloseTo(result.floor, 6);
  });
});

describe("staying inside its cost ceiling", () => {
  it("shortens the window rather than spending minutes on a fast model", () => {
    const result = sweep(queueTarget(400), { budget: FAST });

    expect(result.budget.measureSeconds).toBeLessThan(FAST.measureSeconds);
    // Reported as the window actually used, so the qualifier cannot name a window
    // the run did not have.
    expect(result.budget.measureSeconds * result.ceiling).toBeLessThanOrEqual(FAST.maxProbeRequests);
  });

  it("refuses a model too fast to sweep rather than freezing on it", () => {
    expect(() => sweep(queueTarget(50_000), { budget: FAST })).toThrow(/too slow to run while you wait/);
  });
});

describe("what the search holds fixed, and what it varies", () => {
  it("runs every search probe on the design's own arrival stream", () => {
    const result = sweep(queueTarget(25, "fixed-seed"), { budget: FAST });

    // Common random numbers: the rate is the only thing that differs between
    // probes, which is what makes their verdicts comparable at all.
    expect(new Set(result.probes.map((probe) => probe.seed))).toEqual(new Set(["fixed-seed"]));
  });

  it("re-runs the holding rate on a second, derived stream", () => {
    const result = sweep(queueTarget(25, "fixed-seed"), { budget: FAST });

    expect(result.confirmation?.rate).toBe(result.holds);
    expect(result.confirmation?.seed).toBe("fixed-seed/confirm");
  });

  it("is reproducible: same design, same seed, same answer", () => {
    const first = sweep(queueTarget(25, "repeat"), { budget: FAST });
    const second = sweep(queueTarget(25, "repeat"), { budget: FAST });

    expect(second.probes.map((probe) => probe.rate)).toEqual(first.probes.map((probe) => probe.rate));
    expect(second.holds).toBe(first.holds);
    expect(second.folds).toBe(first.folds);
    expect(second.seedSensitive).toBe(first.seedSensitive);
  });
});

describe("naming a fold that loses nothing", () => {
  it("names the component work is piling up in, when no buffer is full", () => {
    // Found by drawing a real system, whose queues were configured far larger
    // than anything that ever fills. Nothing was
    // ever dropped and no buffer ever looked full, so the canvas's rule — losses
    // or a filling buffer — named nobody, and the sweep reported a breaking point
    // with no component responsible for it.
    const result = sweep(queueTarget(25), { budget: FAST });

    expect(result.folds).not.toBeNull();
    expect(result.firstToFold).toBe("node");
    expect(result.firstToFoldReason).toMatch(/piling up/);
  });

  it("ignores a component drifting by a rounding error", () => {
    // The first version had no floor, so the *deepest* node with any positive
    // drift won on depth alone — which named a datastore that was 3% busy and
    // accumulating nothing, in front of the tier that was actually the limit.
    const model: ModelSnapshot = {
      entryId: "front",
      nodes: [
        {
          id: "front",
          kind: "service",
          spec: {
            concurrency: 1,
            service: { policy: "exponential", mean: 1 / 12 },
            queue: { policy: "fifo", capacity: 10_000_000 },
            timeout: { policy: "none", after: 1 },
            retry: { policy: "none", attempts: 0, delay: 0, factor: 2, maxDelay: 1 },
          },
        },
        {
          id: "back",
          kind: "datastore",
          spec: {
            concurrency: 64,
            service: { policy: "exponential", mean: 0.0001 },
            queue: { policy: "fifo", capacity: 10_000_000 },
          },
        },
      ],
      edges: [{ from: "front", to: "back" }],
    };

    const result = sweep({ model, seed: "drift", baseRate: 6 }, { budget: FAST });

    // `back` is deeper, and idle. The constraint is the single-slot front tier.
    expect(result.firstToFold).toBe("front");
  });
});

describe("a real model with feedback in it", { timeout: 30_000 }, () => {
  const model = demoTimeline().model;

  it("names the component that started the trouble, not the one in front of it", () => {
    const result = sweep({ model, seed: "demo-v1", baseRate: DEMO_BASE_RATE });

    // The application tier is what visibly fails — it is the thing timing out and
    // giving up on requests. It is failing because the datastore behind it cannot
    // keep up, and blaming the visible symptom is the mistake this exists to avoid.
    expect(result.firstToFold).toBe("orders-db");
    expect(result.firstToFoldReason).toContain("queue is full");
  });

  it("refuses to call a metastable design's bracket a breaking point", () => {
    // Measured, not assumed: swept on its own seed the demo brackets 26.1–27.5/s,
    // and 26.1/s does not survive a second arrival stream. Its collapse is a rare
    // burst tipping a feedback loop, so what it holds is a matter of luck — across
    // twelve seeds the bracket moves between 19/s and 29/s.
    const result = sweep({ model, seed: "demo-v1", baseRate: DEMO_BASE_RATE });

    expect(result.confirmation?.verdict.holds).toBe(false);
    expect(result.seedSensitive).toBe(true);
  });

  it("confirms the bracket when the design is not luck-dependent", () => {
    const result = sweep({ model, seed: "scan-0", baseRate: DEMO_BASE_RATE });

    expect(result.confirmation?.verdict.holds).toBe(true);
    expect(result.seedSensitive).toBe(false);
  });
});
