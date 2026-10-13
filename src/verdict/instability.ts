/**
 * The instability detector: does this design hold at this load, or fold?
 *
 * This is the single judgement the breaking-point sweep is made of, so it is
 * kept separate from the search that calls it and from the panel that shows the
 * answer. It reads a finished probe run's metrics and returns a verdict with the
 * numbers that produced it, which is the only way a room can argue with it.
 *
 * Two signals, OR'd, because the palette can fail in two shapes:
 *
 * **Work is not getting served.** Offered load arrives, less of it completes.
 * This is what a bounded queue does — it sheds — and what a retry storm does,
 * spectacularly: goodput goes to zero while the components stay busy. Nothing
 * about that shows up as a growing queue, because the queue is capped and the
 * excess is being thrown away.
 *
 * **Work is piling up.** An unbounded queue in overload does not lose anything;
 * it grows without limit and latency follows it. Deficit alone eventually catches
 * this too (work stuck in a queue has not completed), but the slope catches it
 * earlier and says something different about the same run, so both are reported.
 *
 * Saturation is deliberately *not* a criterion, only a corroborating note. A
 * component pinned at 100% with a short queue is keeping up. Treating full
 * utilization as failure is the mistake the live view already made once, where
 * it painted every busy component red and buried the one in trouble.
 *
 * ## What a verdict is not
 *
 * It is not a statement about the design in general. It is a statement about a
 * run of declared length. Some designs in this palette are *metastable* — the
 * demo system holds at 25/s on two seeds out of three and collapses on the third,
 * because a rare burst tips a feedback loop that then sustains itself. For those,
 * "the breaking point" is a rate *and* an observation window, and a verdict that
 * hid the window would be a confident answer to a question nobody asked. So the
 * probe budget travels with the verdict and the readout prints it.
 */
import type { BucketSample } from "../engine/metrics.ts";

/**
 * The thresholds, declared rather than tuned until the answer looked right.
 *
 * Both are fractions of the offered rate, so they mean the same thing on a model
 * serving 5 requests a second and one serving 5,000. The numbers themselves are
 * measured — see `instability.test.ts`, which pins the false-positive side against
 * stable M/M/1 queues up to ρ = 0.95 and the false-negative side against known
 * overload.
 */
export const DETECTOR = {
  /**
   * Share of offered load that may go unserved and still count as holding.
   *
   * Not zero. A finite window ends with work legitimately in flight, and a queue
   * at ρ = 0.95 is often holding several requests when the window closes — that
   * shortfall is a snapshot artefact, not a loss. It is set above the largest
   * deficit measured on any stable point in the validation corpus.
   */
  deficit: 0.02,
  /**
   * Growth in work-in-system per second, as a fraction of the offered rate.
   *
   * A stable queue's occupancy wanders but does not trend; an unstable one grows
   * at (λ − μ) requests per second, which is this fraction times λ.
   */
  growth: 0.01,
} as const;

export interface Signals {
  /** Requests per second the probe offered. */
  offered: number;
  /** Requests per second that completed for somebody. */
  goodput: number;
  /** Share of offered load that never completed, 0 to 1. */
  deficit: number;
  /** Work-in-system growth per sim second, in requests. */
  growth: number;
  /** `growth` as a fraction of the offered rate. Scale-free, and what is compared. */
  growthFraction: number;
  /**
   * The busiest component's mean utilization over the window. Corroborating only.
   *
   * A mean rather than the highest bucket. A single saturated second happens at
   * half load — measured at 1.000 on an M/M/1 queue at ρ = 0.5 — so a peak here
   * would report every design as saturated and mean nothing.
   */
  busiest: number;
  /** Sim seconds the signals were measured over, after warm-up. */
  measuredSeconds: number;
}

export type FoldCause = "loss" | "growth" | "both";

export interface Verdict {
  holds: boolean;
  /** Which signal fired. `null` when the design held. */
  cause: FoldCause | null;
  signals: Signals;
  /** One sentence in the run's own numbers, so the claim can be checked. */
  reason: string;
}

/**
 * Least-squares slope of a series against sim time, in units per second.
 *
 * A slope rather than last-minus-first: the end-of-bucket occupancy of a stable
 * queue is noisy, and two noisy endpoints can manufacture a trend out of a run
 * that has none. Regressing over every bucket in the window uses all of it.
 */
export function trend(buckets: readonly BucketSample[], value: (bucket: BucketSample) => number): number {
  if (buckets.length < 2) return 0;

  let sumT = 0;
  let sumV = 0;
  for (const bucket of buckets) {
    sumT += bucket.end;
    sumV += value(bucket);
  }
  const meanT = sumT / buckets.length;
  const meanV = sumV / buckets.length;

  let covariance = 0;
  let variance = 0;
  for (const bucket of buckets) {
    const dt = bucket.end - meanT;
    covariance += dt * (value(bucket) - meanV);
    variance += dt * dt;
  }

  return variance === 0 ? 0 : covariance / variance;
}

/**
 * Read the signals out of a measured window.
 *
 * `buckets` must already have the warm-up truncated — sizing that is the sweep's
 * job, because it knows the budget it declared.
 */
export function signalsFor(buckets: readonly BucketSample[], offered: number): Signals {
  const measuredSeconds = buckets.reduce((total, bucket) => total + (bucket.end - bucket.start), 0);

  let arrivals = 0;
  let completions = 0;
  const utilizationTotals = new Map<string, number>();
  for (const bucket of buckets) {
    arrivals += bucket.system.arrivals;
    completions += bucket.system.completions;
    for (const [id, node] of Object.entries(bucket.nodes)) {
      utilizationTotals.set(id, (utilizationTotals.get(id) ?? 0) + node.utilization);
    }
  }
  const windows = buckets.length || 1;
  const busiest = Math.max(0, ...[...utilizationTotals.values()].map((total) => total / windows));

  const goodput = measuredSeconds === 0 ? 0 : completions / measuredSeconds;
  // Against the arrivals actually admitted in the window rather than against the
  // nominal rate: a Poisson stream delivers a few percent more or less than its
  // mean over a finite window, and charging that difference to the design would
  // make the verdict depend on the seed.
  const deficit = arrivals === 0 ? 0 : Math.max(0, (arrivals - completions) / arrivals);
  const growth = trend(buckets, (bucket) => bucket.system.inFlightEnd);

  return {
    offered,
    goodput,
    deficit,
    growth,
    growthFraction: offered === 0 ? 0 : growth / offered,
    busiest,
    measuredSeconds,
  };
}

function describe(signals: Signals, cause: FoldCause | null): string {
  const rate = (value: number): string => (value >= 10 ? value.toFixed(0) : value.toFixed(2));
  const served = `serving ${rate(signals.goodput)}/s of ${rate(signals.offered)}/s offered`;

  switch (cause) {
    case "loss":
      return `${served} — ${(signals.deficit * 100).toFixed(0)}% of the load never completed`;
    case "growth":
      return `work in the system grew by ${signals.growth.toFixed(1)} requests every second, ${served}`;
    case "both":
      return (
        `${served}, and work in the system grew by ${signals.growth.toFixed(1)} requests every second`
      );
    default:
      return `${served}, with work in the system flat`;
  }
}

export function detect(buckets: readonly BucketSample[], offered: number): Verdict {
  const signals = signalsFor(buckets, offered);

  const losing = signals.deficit > DETECTOR.deficit;
  const growing = signals.growthFraction > DETECTOR.growth;
  const cause: FoldCause | null = losing && growing ? "both" : losing ? "loss" : growing ? "growth" : null;

  return { holds: cause === null, cause, signals, reason: describe(signals, cause) };
}
