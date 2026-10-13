import { beforeAll, describe, expect, it } from "vitest";
import {
  BUDGET,
  LITTLES_LAW_TOLERANCE,
  STANDARD_CHECKS,
  formatReport,
  planFor,
  runPoint,
  runValidation,
  type Budget,
  type PointSpec,
  type ValidationReport,
} from "./harness.ts";
import { relaxationTime } from "./closedform.ts";

/**
 * R13, the credibility gate: the simulator reproduces textbook queueing results.
 *
 * The suite is slow on purpose — about 9 million completions across nine points —
 * because the alternative is a fast suite that passes on a lucky seed. The budget
 * was fixed from a convergence study before any tolerance was set; see the note
 * on `BUDGET`.
 */

const STANDARD_TOLERANCE = 0.05;

/** Small and cheap: used where the thing under test is a 40% divergence. */
const COARSE: Budget = { ...BUDGET, targetCompletions: 50_000, warmUpRelaxations: 20 };

describe("the validation suite", () => {
  let report: ValidationReport;

  beforeAll(() => {
    report = runValidation();
  }, 600_000);

  it("passes every check", () => {
    // The formatted report is the failure message, so a red CI run says which
    // point drifted and by how much rather than just "false is not true".
    expect(report.ok, `\n${formatReport(report)}\n`).toBe(true);
  });

  it("reproduces M/M/1 mean latency across the utilization range", () => {
    const check = report.checks.find((c) => c.name.startsWith("M/M/1"));
    expect(check).toBeDefined();
    expect(check?.points.length).toBeGreaterThanOrEqual(5);

    for (const point of check?.points ?? []) {
      expect(point.error, `${point.label}: ${formatReport(report)}`).toBeLessThanOrEqual(point.tolerance);
      // Utilization is the easy one, so it is held to a much tighter band: a
      // component that got rho wrong would be wrong about everything.
      expect(Math.abs(point.measured.utilization - point.expected.utilization)).toBeLessThan(0.005);
    }
  });

  it("reproduces M/M/c against Erlang C, including a wide pool", () => {
    const check = report.checks.find((c) => c.name.startsWith("M/M/c"));
    expect(check).toBeDefined();
    expect(check?.points.some((point) => point.servers >= 8)).toBe(true);

    for (const point of check?.points ?? []) {
      expect(point.error, `${point.label}: ${formatReport(report)}`).toBeLessThanOrEqual(point.tolerance);
    }
  });

  it("satisfies Little's Law at every point, to a far tighter band than latency", () => {
    // L, W and the departure rate come from three separate accumulators inside the
    // kernel. Their agreeing to a fraction of a percent is what says the metrics
    // are internally consistent, independently of whether the queueing is right.
    for (const point of report.checks.flatMap((check) => check.points)) {
      expect(point.littlesLawError, point.label).toBeLessThanOrEqual(LITTLES_LAW_TOLERANCE);
    }
  });

  it("actually spent the budget it declared", () => {
    for (const point of report.checks.flatMap((check) => check.points)) {
      // Slightly under a million is expected: requests still in the queue when the
      // run ends have not completed and are not counted.
      expect(point.budget.completions, point.label).toBeGreaterThan(0.9 * BUDGET.targetCompletions);
      expect(point.budget.warmUpSeconds, point.label).toBeGreaterThan(0);
    }
    expect(report.totals.completions).toBeGreaterThan(8_000_000);
    expect(report.budget.targetCompletions).toBe(BUDGET.targetCompletions);
  });

  it("returns something displayable, so the app panel and the suite show one truth", () => {
    // R13's artifact is shown to a room on demand. It needs the formula, the
    // measurement, the target and the budget — enough to be argued with.
    for (const check of report.checks) {
      expect(check.formula).toMatch(/[=]/);
      for (const point of check.points) {
        expect(point.label.length).toBeGreaterThan(0);
        expect(point.expected.sojourn).toBeGreaterThan(0);
        expect(point.measured.sojourn).toBeGreaterThan(0);
      }
    }

    const text = formatReport(report);
    expect(text).toContain("M/M/1");
    expect(text).toContain("W = 1 / (μ − λ)");
    expect(text).toContain("completions");
    expect(text).toContain(BUDGET.seed);
  });
});

describe("the budget and the tolerances are declared, not discovered", () => {
  it("never widens a tolerance without saying why", () => {
    // The failure mode this exists to prevent: a point quietly gets a 20% band
    // because it would not pass at 5%, and nobody notices the suite stopped
    // checking anything there.
    for (const check of STANDARD_CHECKS) {
      for (const point of check.points) {
        if (point.tolerance > STANDARD_TOLERANCE) {
          expect(point.toleranceNote, `${point.label} has a widened band and no reason`).toBeDefined();
          expect((point.toleranceNote ?? "").length).toBeGreaterThan(80);
        }
      }
    }
  });

  it("sizes every run from that point's own relaxation time", () => {
    const easy = planFor({ label: "easy", lambda: 25, mu: 50, servers: 1, tolerance: 0.05 });
    const hard = planFor({ label: "hard", lambda: 47.5, mu: 50, servers: 1, tolerance: 0.05 });

    // The hard point settles 100x slower, so its warm-up truncation is 100x longer.
    expect(hard.warmUpSeconds / easy.warmUpSeconds).toBeCloseTo(100, 4);
    expect(hard.warmUpSeconds).toBeCloseTo(BUDGET.warmUpRelaxations * relaxationTime(47.5, 50), 6);
  });

  it("truncates warm-up to whole metrics windows, so no window straddles the boundary", () => {
    for (const check of STANDARD_CHECKS) {
      for (const point of check.points) {
        const plan = planFor(point);
        expect(plan.warmUpBuckets * plan.bucketWidth).toBeGreaterThanOrEqual(plan.warmUpSeconds);
        expect(plan.warmUpBuckets).toBeLessThan(BUDGET.buckets / 2);
      }
    }
  });

  it("covers utilizations from comfortable to near-saturation", () => {
    const utilizations = STANDARD_CHECKS.flatMap((check) =>
      check.points.map((point) => point.lambda / (point.servers * point.mu)),
    );
    expect(Math.min(...utilizations)).toBeLessThanOrEqual(0.5);
    expect(Math.max(...utilizations)).toBeGreaterThanOrEqual(0.95);
  });
});

describe("the suite can fail", () => {
  /**
   * A validation suite that cannot go red proves nothing. These point the harness
   * at components that genuinely are not the queue the formula describes, and check
   * that it objects instead of quietly passing.
   */

  it("flags a constant-service-time node checked against the M/M/1 formula", () => {
    // M/D/1 at rho = 0.8 sits about 40% below M/M/1. Same arrival process, same
    // utilization, same throughput — only the service distribution differs, which
    // is exactly the kind of semantic drift the suite has to notice.
    const disguised: PointSpec = {
      label: "M/D/1 wearing M/M/1's formula",
      lambda: 20,
      mu: 25,
      servers: 1,
      tolerance: 0.05,
      spec: {
        concurrency: 1,
        service: { policy: "fixed", mean: 1 / 25 },
        queue: { policy: "fifo", capacity: 10_000_000 },
        timeout: { policy: "none", after: 1 },
        retry: { policy: "none", attempts: 0, delay: 0, factor: 2, maxDelay: 1 },
      },
    };

    const result = runPoint(disguised, COARSE);

    expect(result.ok).toBe(false);
    expect(result.error).toBeGreaterThan(0.3);
    // Little's Law still holds — the metrics are fine, the queue is just different.
    // That separation is the useful part: it says "wrong dynamics", not "wrong bookkeeping".
    expect(result.littlesLawError).toBeLessThanOrEqual(LITTLES_LAW_TOLERANCE);
  });

  it("flags a node with more servers than the formula was given", () => {
    const overprovisioned: PointSpec = {
      label: "three servers, one-server formula",
      lambda: 20,
      mu: 25,
      servers: 1,
      tolerance: 0.05,
      spec: {
        concurrency: 3,
        service: { policy: "exponential", mean: 1 / 25 },
        queue: { policy: "fifo", capacity: 10_000_000 },
        timeout: { policy: "none", after: 1 },
        retry: { policy: "none", attempts: 0, delay: 0, factor: 2, maxDelay: 1 },
      },
    };

    const result = runPoint(overprovisioned, COARSE);

    expect(result.ok).toBe(false);
    expect(result.measured.sojourn).toBeLessThan(result.expected.sojourn);
    expect(result.error).toBeGreaterThan(0.3);
  });

  it("flags a node that sheds work, where the formula assumes an unbounded queue", () => {
    const shedding: PointSpec = {
      label: "bounded queue, unbounded formula",
      lambda: 45,
      mu: 50,
      servers: 1,
      tolerance: 0.05,
      spec: {
        concurrency: 1,
        service: { policy: "exponential", mean: 1 / 50 },
        queue: { policy: "fifo", capacity: 3 },
        timeout: { policy: "none", after: 1 },
        retry: { policy: "none", attempts: 0, delay: 0, factor: 2, maxDelay: 1 },
      },
    };

    const result = runPoint(shedding, COARSE);

    expect(result.ok).toBe(false);
    // Shedding keeps latency *low*, which is the seductive version of this error:
    // the numbers look better than theory, and they are measuring a different system.
    expect(result.measured.sojourn).toBeLessThan(result.expected.sojourn);
  });
});

describe("the artifact is stable between showings", () => {
  it("gives the same numbers every time it is run", () => {
    // R13 is demonstrated live. A suite whose numbers move between the rehearsal
    // and the review is not evidence of anything.
    const point: PointSpec = { label: "ρ = 0.80", lambda: 40, mu: 50, servers: 1, tolerance: 0.05 };

    const first = runPoint(point, COARSE);
    const second = runPoint(point, COARSE);

    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });
});
