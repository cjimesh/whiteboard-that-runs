/**
 * The validation harness (R13).
 *
 * Runs the real palette components against closed-form queueing results and
 * returns a report that is both the CI assertion and the thing shown on screen —
 * one code path, so what the room sees is what the suite checks. The argument it
 * is built to win is "don't trust me, here's the textbook curve and my simulator
 * reproducing it", and that argument dies if the on-screen numbers came from a
 * different, friendlier run than the tests did.
 *
 * Two things are declared up front rather than discovered:
 *
 * **The run budget.** Every point is sized from its own relaxation time, so the
 * warm-up truncation and measurement window stretch as utilization rises. A
 * single fixed run length would pass at ρ = 0.5 and quietly fail at ρ = 0.9 —
 * and the temptation then is to widen the tolerance until it passes, which turns
 * a validation suite into a decoration. The budget is set from theory before any
 * result is looked at.
 *
 * **The tolerance, per point.** Including a wider one near saturation, stated as
 * a reason rather than left as a number nobody asks about.
 *
 * The models here double as the instability detector's fixtures (U7), with one
 * caveat worth carrying: they are all stable, retry-free queues. They pin the
 * detector against known-good dynamics, not against retry feedback, which needs
 * its own fixtures.
 */
import type { BucketSample } from "../engine/metrics.ts";
import type { Timeline } from "../engine/timeline.ts";
import { createModelSimulation } from "../specs/registry.ts";
import type { PartialComponentSpec } from "../specs/format.ts";
import {
  mmcMeanResident,
  mmcMeanSojourn,
  relativeError,
  relaxationTime,
  utilization,
} from "./closedform.ts";

/**
 * The declared run budget. Changing these numbers changes what the suite proves,
 * so they are constants with a version tag rather than tuning knobs.
 */
export interface Budget {
  targetCompletions: number;
  warmUpRelaxations: number;
  minMeasuredRelaxations: number;
  buckets: number;
  seed: string;
}

export const BUDGET: Budget = {
  /**
   * Completions to measure at each point, before warm-up is added on top.
   *
   * 10⁶, not the 10⁵ first tried. At 10⁵ the seed-to-seed spread on a single
   * point is already several percent, so a ±5% claim would have been decided by
   * which seed was picked — the suite would have been measuring luck. Convergence
   * was checked before this number was fixed: at ρ = 0.9 the error falls 7.1% →
   * 1.9% → 0.36% as the budget goes 10⁵ → 10⁶ → 4×10⁶, which is sampling error
   * behaving like sampling error rather than a bias that will not shift.
   */
  targetCompletions: 1_000_000,
  /** Warm-up truncation, in relaxation times. */
  warmUpRelaxations: 100,
  /** Floor on the measurement window, in relaxation times. */
  minMeasuredRelaxations: 1_000,
  /** Metrics windows per run; warm-up is truncated to a whole number of them. */
  buckets: 100,
  seed: "validation-v1",
};

export interface PointSpec {
  label: string;
  /**
   * Seconds the slot stays taken, when the point is testing a lease.
   *
   * When set, `mu` is the rate the *hold* implies rather than the service rate,
   * the component answers its caller almost immediately, and the closed form is
   * the Erlang C wait to acquire plus that answer time. A lease is an M/M/c
   * server whose service time is the hold — this is where that claim is checked
   * rather than asserted.
   */
  hold?: { serviceSeconds: number };
  /** Arrival rate, per second. */
  lambda: number;
  /** Service rate of one server, per second. */
  mu: number;
  servers: number;
  /** Allowed relative error on mean sojourn time. */
  tolerance: number;
  /** Why this point's tolerance is not the usual one, if it is not. */
  toleranceNote?: string;
  /**
   * Overrides the node's spec. Used by the suite's own self-check to point the
   * harness at a queue that is deliberately not the one the formula describes.
   */
  spec?: PartialComponentSpec;
}

export interface CheckSpec {
  name: string;
  /** The closed form being checked, written out for the on-screen panel. */
  formula: string;
  points: readonly PointSpec[];
}

export interface Measurement {
  /** Mean time in system, completion-weighted across the measurement window. */
  sojourn: number;
  /** Time-averaged number in system — `L`. */
  resident: number;
  /** Time-averaged busy servers over declared servers. */
  utilization: number;
  /** Departure rate over the measurement window, for Little's Law. */
  throughput: number;
  completions: number;
}

export interface PointResult {
  label: string;
  lambda: number;
  mu: number;
  servers: number;
  measured: Measurement;
  expected: {
    sojourn: number;
    resident: number;
    utilization: number;
  };
  /** Relative error on mean sojourn — the headline number. */
  error: number;
  /** Relative error on L against λ·W measured from the same run. */
  littlesLawError: number;
  tolerance: number;
  toleranceNote?: string;
  ok: boolean;
  /** What the run cost, so the budget is visible alongside the result. */
  budget: { simSeconds: number; warmUpSeconds: number; completions: number };
}

export interface CheckResult {
  name: string;
  formula: string;
  points: PointResult[];
  ok: boolean;
}

export interface ValidationReport {
  ok: boolean;
  seed: string;
  /** The budget this report was produced under, so a non-default run labels itself. */
  budget: Budget;
  checks: CheckResult[];
  totals: { simSeconds: number; completions: number };
}

/** Little's Law is checked against this, separately from the sojourn tolerance. */
export const LITTLES_LAW_TOLERANCE = 0.02;

/**
 * The standard checks. Utilization points are spread rather than clustered, so a
 * component that is right in the easy regime and wrong near saturation cannot
 * pass — which is the regime the whole tool reports on.
 */
export const STANDARD_CHECKS: readonly CheckSpec[] = [
  {
    name: "M/M/1 — mean latency against utilization",
    formula: "W = 1 / (μ − λ)",
    points: [
      { label: "ρ = 0.50", lambda: 25, mu: 50, servers: 1, tolerance: 0.05 },
      { label: "ρ = 0.70", lambda: 35, mu: 50, servers: 1, tolerance: 0.05 },
      { label: "ρ = 0.80", lambda: 40, mu: 50, servers: 1, tolerance: 0.05 },
      { label: "ρ = 0.90", lambda: 45, mu: 50, servers: 1, tolerance: 0.05 },
      {
        label: "ρ = 0.95",
        lambda: 47.5,
        mu: 50,
        servers: 1,
        tolerance: 0.12,
        toleranceNote:
          "Wider on purpose, and the width is measured rather than chosen. At this utilization a " +
          "single run's mean genuinely wanders: three independent seeds at the declared budget " +
          "gave −4.5%, +7.8% and −1.0%. That spread is the queue's own variance near saturation, " +
          "not a bias a longer run removes — reaching ±5% here costs roughly 4× the whole rest of " +
          "the suite. So the band admits the wander and says so, which is also a true thing about " +
          "queues at ρ = 0.95 worth knowing.",
      },
    ],
  },
  {
    /**
     * The lease (R10, added after a real system turned out to be limited by one).
     *
     * A pool whose slots are held long after the request that took one has been
     * answered. If this is really an M/M/c server whose service time is the hold,
     * the wait to acquire is Erlang C and the utilization is λ/(cμ) — measured
     * here against both, on the same components the canvas runs.
     */
    name: "Leases — the wait to acquire against Erlang C",
    formula: "W = C(c, λ/μ_hold) / (cμ_hold − λ) + answer time",
    points: [
      { label: "c = 8, ρ = 0.85", lambda: 68, mu: 10, servers: 8, tolerance: 0.05, hold: { serviceSeconds: 0.002 } },
      { label: "c = 5, ρ = 0.90", lambda: 45, mu: 10, servers: 5, tolerance: 0.05, hold: { serviceSeconds: 0.002 } },
      {
        label: "c = 1000, ρ = 0.75",
        // The shape the concern was built for: a large pool, a long hold, and a
        // request answered in a fraction of it.
        lambda: 25 / 3,
        mu: 1 / 90,
        servers: 1000,
        tolerance: 0.05,
        hold: { serviceSeconds: 2 },
      },
    ],
  },
  {
    name: "M/M/c — mean latency against Erlang C",
    formula: "W = C(c, λ/μ) / (cμ − λ) + 1/μ",
    points: [
      { label: "c = 4, ρ = 0.50", lambda: 50, mu: 25, servers: 4, tolerance: 0.05 },
      { label: "c = 4, ρ = 0.80", lambda: 80, mu: 25, servers: 4, tolerance: 0.05 },
      { label: "c = 4, ρ = 0.90", lambda: 90, mu: 25, servers: 4, tolerance: 0.05 },
      { label: "c = 8, ρ = 0.85", lambda: 68, mu: 10, servers: 8, tolerance: 0.05 },
    ],
  },
];

interface Plan {
  warmUpSeconds: number;
  totalSeconds: number;
  bucketWidth: number;
  warmUpBuckets: number;
}

/** Size a run from the point's own relaxation time. See `BUDGET`. */
export function planFor(point: PointSpec, budget: Budget = BUDGET): Plan {
  const relax = relaxationTime(point.lambda, point.mu, point.servers);
  const warmUpSeconds = budget.warmUpRelaxations * relax;
  const measuredSeconds = Math.max(
    budget.targetCompletions / point.lambda,
    budget.minMeasuredRelaxations * relax,
  );
  const totalSeconds = warmUpSeconds + measuredSeconds;
  const bucketWidth = totalSeconds / budget.buckets;
  return {
    warmUpSeconds,
    totalSeconds,
    bucketWidth,
    warmUpBuckets: Math.ceil(warmUpSeconds / bucketWidth),
  };
}

function nodeSpec(point: PointSpec): PartialComponentSpec {
  if (point.hold !== undefined) {
    return {
      concurrency: point.servers,
      service: { policy: "fixed", mean: point.hold.serviceSeconds },
      queue: { policy: "fifo", capacity: 10_000_000 },
      hold: { policy: "exponential", mean: 1 / point.mu },
      timeout: { policy: "none", after: 1 },
      retry: { policy: "none", attempts: 0, delay: 0, factor: 2, maxDelay: 1 },
    };
  }

  return (
    point.spec ?? {
      concurrency: point.servers,
      service: { policy: "exponential", mean: 1 / point.mu },
      // Large enough that nothing is ever shed: a loss would make the measured
      // throughput disagree with λ and the formula would not apply.
      queue: { policy: "fifo", capacity: 10_000_000 },
      timeout: { policy: "none", after: 1 },
      retry: { policy: "none", attempts: 0, delay: 0, factor: 2, maxDelay: 1 },
    }
  );
}

/**
 * Aggregate the measurement window.
 *
 * Time-averages come from the mean of equal-width buckets; the latency mean is
 * weighted by completions, because a bucket that finished four requests should
 * not count as much as one that finished four hundred.
 */
function measure(buckets: readonly BucketSample[], nodeId: string, seconds: number): Measurement {
  let completions = 0;
  let latencyTotal = 0;
  let residentTotal = 0;
  let utilizationTotal = 0;
  let departures = 0;

  for (const bucket of buckets) {
    completions += bucket.system.completions;
    latencyTotal += bucket.system.latencyMean * bucket.system.completions;
    const node = bucket.nodes[nodeId];
    residentTotal += node?.residentMean ?? 0;
    utilizationTotal += node?.utilization ?? 0;
    departures += node?.departures ?? 0;
  }

  const windows = buckets.length || 1;
  return {
    sojourn: completions === 0 ? 0 : latencyTotal / completions,
    resident: residentTotal / windows,
    utilization: utilizationTotal / windows,
    throughput: seconds === 0 ? 0 : departures / seconds,
    completions,
  };
}

export function runPoint(point: PointSpec, budget: Budget = BUDGET): PointResult {
  const plan = planFor(point, budget);
  const timeline: Timeline = {
    model: {
      entryId: "node",
      nodes: [{ id: "node", kind: "service", spec: nodeSpec(point) as Record<string, unknown> }],
      edges: [],
    },
    load: [{ rate: point.lambda, duration: plan.totalSeconds }],
    seed: `${budget.seed}/${point.label}`,
    mutations: [],
    bucketWidth: plan.bucketWidth,
  };

  const sim = createModelSimulation(timeline);
  sim.runUntil(plan.totalSeconds);

  const measured = plan.warmUpBuckets;
  const window = sim.series().slice(measured);
  const measuredSeconds = window.length * plan.bucketWidth;
  const result = measure(window, "node", measuredSeconds);

  // A leased component answers its caller and keeps the slot, so what a request
  // experiences is the wait to acquire — Erlang C — plus the time to answer, not
  // the full occupancy. `L = λW` is then a statement about the callers in the
  // node, which is what the metrics count, so it still holds.
  const answerSeconds = point.hold?.serviceSeconds ?? 0;
  const sojourn =
    point.hold === undefined
      ? mmcMeanSojourn(point.lambda, point.mu, point.servers)
      : mmcMeanSojourn(point.lambda, point.mu, point.servers) - 1 / point.mu + answerSeconds;

  const expected = {
    sojourn,
    resident: point.hold === undefined ? mmcMeanResident(point.lambda, point.mu, point.servers) : point.lambda * sojourn,
    utilization: utilization(point.lambda, point.mu, point.servers),
  };

  const error = relativeError(result.sojourn, expected.sojourn);
  // Little's Law is checked against the run's own throughput and sojourn rather
  // than against λ, so it tests the metrics' internal consistency: L, W and the
  // departure rate all come from different accumulators inside the kernel.
  const littlesLawError = relativeError(result.resident, result.throughput * result.sojourn);

  return {
    label: point.label,
    lambda: point.lambda,
    mu: point.mu,
    servers: point.servers,
    measured: result,
    expected,
    error,
    littlesLawError,
    tolerance: point.tolerance,
    ...(point.toleranceNote === undefined ? {} : { toleranceNote: point.toleranceNote }),
    ok: error <= point.tolerance && littlesLawError <= LITTLES_LAW_TOLERANCE,
    budget: {
      simSeconds: plan.totalSeconds,
      warmUpSeconds: plan.warmUpSeconds,
      completions: result.completions,
    },
  };
}

export function runCheck(check: CheckSpec, budget: Budget = BUDGET): CheckResult {
  const points = check.points.map((point) => runPoint(point, budget));
  return {
    name: check.name,
    formula: check.formula,
    points,
    ok: points.every((point) => point.ok),
  };
}

/**
 * Run the validation suite and return a displayable report.
 *
 * Callable from a test and from the app's Validation panel with no difference in
 * what it does.
 */
export interface RunValidationOptions {
  checks?: readonly CheckSpec[];
  budget?: Budget;
  /**
   * Called as each point lands.
   *
   * Exists so the panel can fill in a row at a time instead of showing nothing
   * for half a minute. It observes; it cannot change what is measured, so the
   * streamed rows and the final report are the same numbers.
   */
  onPoint?: (point: PointResult, checkName: string) => void;
}

export function runValidation(options: RunValidationOptions = {}): ValidationReport {
  const checks = options.checks ?? STANDARD_CHECKS;
  const budget = options.budget ?? BUDGET;

  const results: CheckResult[] = checks.map((check) => {
    const points = check.points.map((point) => {
      const result = runPoint(point, budget);
      options.onPoint?.(result, check.name);
      return result;
    });
    return { name: check.name, formula: check.formula, points, ok: points.every((p) => p.ok) };
  });
  const all = results.flatMap((check) => check.points);

  return {
    ok: results.every((check) => check.ok),
    seed: budget.seed,
    budget,
    checks: results,
    totals: {
      simSeconds: all.reduce((total, point) => total + point.budget.simSeconds, 0),
      completions: all.reduce((total, point) => total + point.budget.completions, 0),
    },
  };
}

/** One line per point, for the on-screen panel and for a failing test's output. */
export function formatReport(report: ValidationReport): string {
  const lines: string[] = [];
  for (const check of report.checks) {
    lines.push(`${check.ok ? "PASS" : "FAIL"}  ${check.name}`);
    lines.push(`      ${check.formula}`);
    for (const point of check.points) {
      lines.push(
        `      ${point.ok ? "ok  " : "FAIL"} ${point.label.padEnd(14)} ` +
          `W ${point.measured.sojourn.toFixed(5)} vs ${point.expected.sojourn.toFixed(5)} ` +
          `(${(point.error * 100).toFixed(2)}% of ${(point.tolerance * 100).toFixed(0)}%)  ` +
          `L=λW ${(point.littlesLawError * 100).toFixed(2)}%  ` +
          `${point.budget.completions.toLocaleString("en-US")} completions`,
      );
    }
  }
  lines.push(
    `seed ${report.seed} · ${Math.round(report.totals.simSeconds).toLocaleString("en-US")} sim seconds · ` +
      `${report.totals.completions.toLocaleString("en-US")} completions`,
  );
  return lines.join("\n");
}
