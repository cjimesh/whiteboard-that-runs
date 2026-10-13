/**
 * The breaking-point sweep: the load a design holds to, reported as a bracket.
 *
 * The live view answers "what is happening now". This answers "how much can it
 * take" — the question a design review actually argues about, and the one nobody
 * can settle by looking at a diagram. It runs the model headless at candidate
 * rates until it has bracketed the rate where it stops holding.
 *
 * Four things about how it does that are deliberate, and each of them is a way
 * the obvious implementation would have lied.
 *
 * **The probe stream is synthesized, not the authored load.** The live view runs
 * whatever load segments the author drew — a ramp, a spike, a burst. A breaking
 * point measured against a ramp would be a fact about the ramp. Each probe holds
 * one steady rate for the whole budget, so "holds to 40/s" means a sustained
 * 40/s, which is what everyone in the room hears anyway.
 *
 * **Every probe uses the same seed.** Common random numbers: the difference
 * between two probes is the rate and nothing else. Re-seeding per probe would add
 * a second source of variation to a search that is trying to isolate the first.
 *
 * **The answer is a bracket, never a point.** Bisection can always run one more
 * halving, and the number it converges on stops meaning anything long before it
 * stops moving — near the boundary a probe's verdict is decided by the seed. So
 * the search stops at a declared resolution and reports the interval it actually
 * distinguished. A single number here would be false precision about the one
 * figure people would quote.
 *
 * **The bracket is confirmed against a second arrival stream.** Bisection assumes
 * that if a design folds at rate r it folds at everything above r, and it can
 * never catch itself out on that: every probe it takes lies strictly between a
 * rate that held and one that folded, so its own probes cannot contradict each
 * other. Some designs in this palette break the assumption anyway. The demo
 * system is metastable — its collapse is a rare burst tipping a feedback loop, so
 * whether a given rate survives is partly a matter of which arrivals turned up —
 * and swept on different seeds its holding rate moves by a quarter.
 *
 * So after the bracket is found, one more probe re-runs the holding rate under a
 * different arrival stream. If that folds, the bracket was a fact about the seed
 * and the result says so. "This design has no clean threshold" is a true and
 * useful answer; a tidy number standing in for it is not.
 */
import type { BucketSample } from "../engine/metrics.ts";
import type { ModelSnapshot, Timeline } from "../engine/timeline.ts";
import { createModelSimulation } from "../specs/registry.ts";
import { frameFor, nodeDepths } from "../view/frame.ts";
import { DETECTOR, detect, trend, type Verdict } from "./instability.ts";

/**
 * The declared per-probe budget.
 *
 * Sim seconds rather than completions: this search is about sustained behavior,
 * and the failures it looks for — a retry loop tipping, a queue filling — happen
 * on a timescale, not after a count. A completion-based budget would give a
 * struggling design a *shorter* observation window exactly when it is failing.
 *
 * 240 measured seconds, chosen by measuring where the answer stops moving rather
 * than by picking a round number. Swept at 120s, 240s and 400s across three seeds,
 * the demo system's bracket is identical at 240s and 400s; at 120s it comes out
 * 10% optimistic on two seeds of three, because that design's metastable collapse
 * arrives between 90 and 200 sim seconds and a short window ends before it. The
 * readout prints the window so the claim carries its own qualifier.
 */
export interface SweepBudget {
  /** Discarded before measurement: queues fill from empty and that is not the answer. */
  warmUpSeconds: number;
  /** Measured, when cost allows. Sets the observation window verdicts are relative to. */
  measureSeconds: number;
  /**
   * Cost ceiling: the most requests one probe may simulate.
   *
   * A probe costs about 10 µs per request on this engine, measured, and the
   * search reaches eight times the rate the design is running at — so a model
   * serving 200/s would spend half a minute on a sweep at the full window, in a
   * room, while somebody waits. The window is shortened to fit this instead, and
   * the readout prints the window it actually used.
   */
  maxProbeRequests: number;
  /**
   * The shortest window worth reporting from.
   *
   * Below this the run is too short for the slow dynamics the window exists to
   * catch, so a sweep that cannot fit is refused rather than answered badly.
   */
  minMeasureSeconds: number;
  bucketWidth: number;
  /** Bisection stops once the bracket is this fraction of the folding rate. */
  resolution: number;
  /** Hard stop, so a pathological model cannot run forever in a room. */
  maxProbes: number;
  /** Search range, as multiples of the rate the design is running at. */
  floorMultiple: number;
  ceilingMultiple: number;
}

export const SWEEP_BUDGET: SweepBudget = {
  warmUpSeconds: 20,
  measureSeconds: 240,
  bucketWidth: 1,
  /**
   * 8%, and the number is measured rather than picked for looking tight.
   *
   * On an M/M/1 queue with μ = 50 at this budget, five seeds agree on "holds" up
   * to λ = 47.5 and agree on "folds" from λ = 51; between those — across ρ = 0.97
   * to 1.01 — the same design's verdict is decided by which seed ran, including at
   * ρ = 1.000 exactly. That ambiguous band is 6.9% of the folding rate,
   * so a bracket narrower than it would be reporting seed luck as resolution.
   * Rounded up rather than down, because the measurement was taken on the
   * best-behaved model in the palette — a textbook queue with no feedback.
   */
  resolution: 0.08,
  maxProbes: 14,
  /**
   * 200,000 requests, which is about two seconds of simulation per probe. Set so
   * a whole sweep stays inside the few seconds a room will wait while watching
   * probes appear, rather than from anything about queueing.
   */
  maxProbeRequests: 200_000,
  minMeasureSeconds: 30,
  floorMultiple: 0.125,
  ceilingMultiple: 8,
};

export interface Probe {
  rate: number;
  verdict: Verdict;
  /**
   * Which arrival stream this probe ran against.
   *
   * On the search's own probes this is the design's seed — every one of them uses
   * it, so the rate is the only thing that varies. The confirmation probe is the
   * one exception, and carrying the seed on the probe is what makes that visible
   * in the log rather than a footnote.
   */
  seed: string;
}

export interface SweepResult {
  /** Highest probed rate that held. `null` when even the floor folded. */
  holds: number | null;
  /** Lowest probed rate that folded. `null` when nothing folded up to the ceiling. */
  folds: number | null;
  /** The ceiling actually reached, so "holds beyond X" names a real number. */
  ceiling: number;
  floor: number;
  /** The component that started the trouble at the folding probe. */
  firstToFold: string | null;
  /** Why that component, in its own numbers. */
  firstToFoldReason: string | null;
  /**
   * True when the holding rate folded under a different arrival stream — the
   * design has no clean threshold, only a probability of surviving.
   */
  seedSensitive: boolean;
  /** The re-run of the holding rate on a second stream. `null` if there was none. */
  confirmation: Probe | null;
  probes: Probe[];
  budget: SweepBudget;
  /** The rate the design was running at when the sweep was asked for. */
  baseRate: number;
}

export interface SweepOptions {
  budget?: SweepBudget;
  /** Reports each probe as it lands, so a panel can fill in rather than hang. */
  onProbe?: (probe: Probe, index: number, maxProbes: number) => void;
}

/** What a probe needs: the design, its seed, and nothing about how it was driven. */
export interface SweepTarget {
  model: ModelSnapshot;
  seed: string;
  baseRate: number;
}

interface ProbeRun {
  verdict: Verdict;
  /** The component that started the trouble, from the same rule the canvas uses. */
  culprit: { id: string; reason: string } | null;
}

function runProbe(target: SweepTarget, rate: number, seed: string, budget: SweepBudget): ProbeRun {
  const total = budget.warmUpSeconds + budget.measureSeconds;
  const timeline: Timeline = {
    model: target.model,
    load: [{ rate, duration: total }],
    seed,
    mutations: [],
    bucketWidth: budget.bucketWidth,
  };

  const sim = createModelSimulation(timeline);
  sim.runUntil(total);

  const series = sim.series();
  const measured: readonly BucketSample[] = series.filter((bucket) => bucket.start >= budget.warmUpSeconds);
  const verdict = detect(measured, rate);

  // Attribution reuses the canvas's rule rather than inventing a second one, so
  // the component the sweep names is the component the picture would redden. The
  // averaging window is the whole measured run instead of the live view's 1.5s,
  // because this is a judgement about a sustained rate, not about a moment.
  const frame = frameFor({
    model: target.model,
    snapshot: sim.snapshot(),
    series,
    window: budget.measureSeconds,
  });

  if (frame.culprit !== null) {
    return { verdict, culprit: { id: frame.culprit.id, reason: frame.culprit.reason } };
  }

  // The canvas names a component when work is being *lost* or a buffer is
  // filling. A design with generous queues folds without either: nothing is
  // dropped, no buffer looks full, and work simply piles up — and the readout
  // then reported a breaking point with nobody responsible for it. Found by
  // drawing a real system, whose queues were configured far larger than
  // anything that ever fills.
  return { verdict, culprit: verdict.holds ? null : growingCulprit(target.model, measured, rate) };
}

/**
 * Who is piling work up, when nobody is losing any.
 *
 * Same rule as the canvas uses for losses, applied to the other way a component
 * fails: the deepest one growing that has nothing growing behind it. Trouble
 * still propagates backwards — a caller holding its server while a saturated
 * callee answers accumulates work of its own — so the shallowest growing
 * component is the least likely to be the cause.
 */
function growingCulprit(
  model: ModelSnapshot,
  measured: readonly BucketSample[],
  offered: number,
): ProbeRun["culprit"] {
  // Material growth, on the same scale the system-level detector uses: a share of
  // the offered rate. Without a floor, a node drifting by a hundredth of a request
  // a second counts as growing, and the deepest such node wins on depth alone —
  // which named a component that was 3% busy and accumulating nothing.
  const floor = DETECTOR.growth * offered;
  const growth = new Map<string, number>();
  for (const node of model.nodes) {
    const rate = trend(measured, (bucket) => bucket.nodes[node.id]?.residentMean ?? 0);
    if (rate >= floor) growth.set(node.id, rate);
  }
  if (growth.size === 0) return null;

  const downstream = new Map<string, string[]>();
  for (const node of model.nodes) downstream.set(node.id, []);
  for (const edge of model.edges) downstream.get(edge.from)?.push(edge.to);

  const depth = nodeDepths(model);
  const deepestFirst = [...growth.keys()].sort((a, b) => (depth.get(b) ?? 0) - (depth.get(a) ?? 0));
  const origin =
    deepestFirst.find((id) => !(downstream.get(id) ?? []).some((next) => growth.has(next))) ?? deepestFirst[0];
  if (origin === undefined) return null;

  const rate = growth.get(origin) ?? 0;
  return {
    id: origin,
    reason: `work is piling up in it, by ${rate >= 10 ? Math.round(rate) : rate.toFixed(1)} requests every second`,
  };
}

/**
 * Bracket the rate at which this design stops holding.
 *
 * Expands outward from the rate it is running at until it has one holding and one
 * folding probe, then bisects between them. Bailing out at the ceiling or the
 * floor is a reportable answer, not a failure.
 */
export function sweep(target: SweepTarget, options: SweepOptions = {}): SweepResult {
  const declared = options.budget ?? SWEEP_BUDGET;
  const floor = target.baseRate * declared.floorMultiple;
  const ceiling = target.baseRate * declared.ceilingMultiple;

  /**
   * The window, sized to what the most expensive probe would cost.
   *
   * Sized from the ceiling rather than from each probe's own rate, so every probe
   * in one sweep observes for the same length of time. Per-probe windows would be
   * cheaper and would also mean the rates were no longer being compared on equal
   * terms, which is the one thing the search has to get right.
   *
   * Sizing from the ceiling is conservative for a design that turns out to fold
   * below its current load: that search never goes upward, so it observes for
   * less time than it could have afforded. Accepted rather than fixed, because
   * the fix is a window that changes size mid-search.
   */
  const affordable = declared.maxProbeRequests / ceiling;
  const measureSeconds = Math.min(declared.measureSeconds, affordable);

  if (measureSeconds < declared.minMeasureSeconds) {
    throw new Error(
      `this model is running at ${Math.round(target.baseRate)}/s, and sweeping it to ` +
        `${Math.round(ceiling)}/s would simulate more than ${declared.maxProbeRequests.toLocaleString("en-US")} ` +
        `requests per probe — too slow to run while you wait. Sweeping needs at least ` +
        `${declared.minMeasureSeconds}s of observation per rate to mean anything.`,
    );
  }

  // The budget reported alongside the answer is the one actually used, not the
  // one asked for. A qualifier naming a window the run did not have is worse
  // than no qualifier.
  const budget: SweepBudget = { ...declared, measureSeconds };

  const probes: Probe[] = [];
  let holds: number | null = null;
  let folds: number | null = null;
  let firstToFold: string | null = null;
  let firstToFoldReason: string | null = null;
  let confirmation: Probe | null = null;

  /** One search probe: same arrival stream every time, so only the rate varies. */
  const probe = (rate: number): Verdict => {
    const run = runProbe(target, rate, target.seed, budget);
    const record: Probe = { rate, verdict: run.verdict, seed: target.seed };
    probes.push(record);
    options.onProbe?.(record, probes.length, budget.maxProbes);

    if (run.verdict.holds) {
      if (holds === null || rate > holds) holds = rate;
    } else if (folds === null || rate < folds) {
      folds = rate;
      firstToFold = run.culprit?.id ?? null;
      firstToFoldReason = run.culprit?.reason ?? null;
    }

    return run.verdict;
  };

  const done = (): SweepResult => ({
    holds,
    folds,
    ceiling,
    floor,
    firstToFold,
    firstToFoldReason,
    seedSensitive: confirmation !== null && !confirmation.verdict.holds,
    confirmation,
    probes,
    budget,
    baseRate: target.baseRate,
  });

  const first = probe(target.baseRate);

  if (first.holds) {
    // Upward: double until something folds or the ceiling is reached.
    let rate = target.baseRate;
    while (folds === null && rate < ceiling && probes.length < budget.maxProbes) {
      rate = Math.min(rate * 2, ceiling);
      probe(rate);
      if (rate >= ceiling) break;
    }
  } else {
    // Downward: halve until something holds or the floor is reached.
    let rate = target.baseRate;
    while (holds === null && rate > floor && probes.length < budget.maxProbes) {
      rate = Math.max(rate / 2, floor);
      probe(rate);
      if (rate <= floor) break;
    }
  }

  // Bisect the bracket, if there is one to bisect.
  while (
    holds !== null &&
    folds !== null &&
    folds > holds &&
    (folds - holds) / folds > budget.resolution &&
    probes.length < budget.maxProbes
  ) {
    probe((holds + folds) / 2);
  }

  /**
   * The confirmation probe: the holding rate again, on a different arrival stream.
   *
   * Everything above shares one seed on purpose, which is what makes the search a
   * clean comparison — and also what makes its answer a statement about that one
   * realization of the load. This asks the only question that separates "this
   * design holds 26/s" from "this design held 26/s that time".
   *
   * Its seed is derived from the design's rather than picked, so the confirmation
   * is as reproducible as the run it is checking.
   *
   * Deliberately not a vote. If a second stream folds where the first held, the
   * answer is not the average of the two — it is that the design has no clean
   * threshold, which is a different kind of fact and the one worth reporting.
   */
  if (holds !== null) {
    const confirmSeed = `${target.seed}/confirm`;
    const run = runProbe(target, holds, confirmSeed, budget);
    confirmation = { rate: holds, verdict: run.verdict, seed: confirmSeed };
    options.onProbe?.(confirmation, probes.length + 1, budget.maxProbes + 1);
    if (!run.verdict.holds && firstToFold === null) {
      firstToFold = run.culprit?.id ?? null;
      firstToFoldReason = run.culprit?.reason ?? null;
    }
  }

  return done();
}
