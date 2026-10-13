/**
 * The shape of the offered load over time: steady, spiky, random, or a formula.
 *
 * Every pattern compiles to the load segments the engine already runs (see
 * `LoadSegment` in `engine/timeline.ts`), so the engine is untouched and a
 * pattern is replayable for the same reason a slider drag is: the recorded
 * `set-load` carries the segments themselves, not the recipe that made them.
 *
 * Patterns are written against **sim time since the run started**, not against
 * the moment the pattern was picked. Dragging the slider during a spiky run
 * keeps the spikes where they were and changes how tall they are; restarting
 * the shape on every drag would put a spike under the driver's hand each time.
 *
 * The slider stays the one number the room argues about. For spiky load it is
 * the rate between spikes; for random load it is the average. The breaking-point
 * sweep keeps probing steady rates (see `verdict/sweep.ts`), so a pattern changes
 * the live run and leaves that answer alone.
 */
import type { LoadSegment } from "../engine/timeline.ts";
import { createSubstreamSource } from "../engine/prng.ts";
import { compileFormula } from "./rate-formula.ts";

export type LoadPattern =
  | { readonly kind: "steady" }
  /** `height`× the base rate for `lasting` seconds at the end of every `every` seconds. */
  | { readonly kind: "spiky"; readonly height: number; readonly every: number; readonly lasting: number }
  /** A fresh rate every `every` seconds, uniform within ±`spread` (a fraction) of the base. */
  | { readonly kind: "random"; readonly spread: number; readonly every: number }
  /** A rate in `t` and `base`, read once a second. See `rate-formula.ts`. */
  | { readonly kind: "formula"; readonly text: string };

export type PatternKind = LoadPattern["kind"];

export const DEFAULT_PATTERNS: { readonly [K in PatternKind]: Extract<LoadPattern, { kind: K }> } = {
  steady: { kind: "steady" },
  spiky: { kind: "spiky", height: 3, every: 20, lasting: 2 },
  random: { kind: "random", spread: 0.5, every: 5 },
  formula: { kind: "formula", text: "base * (1 + 0.5 * sin(2 * pi * t / 60))" },
};

/** How far ahead a pattern is laid out: the same hour the steady slider has always used. */
export const PATTERN_HORIZON = 3600;

/** A formula is read at whole seconds of sim time. */
const FORMULA_STEP = 1;

// Floors on the timing, so an hour of pattern stays a few thousand segments at
// most. Every drag of the slider records the whole hour into the replay log.
const MIN_EVERY = 1;
const MIN_LASTING = 0.1;

export type PatternResult =
  | { ok: true; segments: LoadSegment[]; mean: number; peak: number }
  | { ok: false; error: string };

export interface PatternOptions {
  /** Sim time the segments start at. */
  from: number;
  /** The run's seed, so random load is the same load on a rerun. */
  seed: string;
  /** Refuse a pattern that peaks above this, because a runaway rate freezes the page. */
  limit: number;
  horizon?: number;
}

/** Problems with a pattern's own parameters, independent of the base rate. */
export function checkPattern(pattern: LoadPattern): string | null {
  switch (pattern.kind) {
    case "steady":
      return null;
    case "spiky":
      if (!(pattern.height >= 1) || !Number.isFinite(pattern.height)) {
        return "A spike has to be at least 1× the base rate.";
      }
      if (!(pattern.every >= MIN_EVERY) || !Number.isFinite(pattern.every)) {
        return `Spikes need a gap of at least ${MIN_EVERY} s.`;
      }
      if (!(pattern.lasting >= MIN_LASTING) || !(pattern.lasting < pattern.every)) {
        return `A spike has to last at least ${MIN_LASTING} s and less than the gap between spikes.`;
      }
      return null;
    case "random":
      if (!(pattern.spread >= 0 && pattern.spread <= 1)) return "The swing has to be between 0% and 100%.";
      if (!(pattern.every >= MIN_EVERY) || !Number.isFinite(pattern.every)) {
        return `Each rate has to hold for at least ${MIN_EVERY} s.`;
      }
      return null;
    case "formula": {
      const compiled = compileFormula(pattern.text);
      return compiled.ok ? null : compiled.error;
    }
  }
}

/**
 * Lay a pattern out as load segments covering `[from, from + horizon)`.
 *
 * Adjacent stretches at the same rate are merged, so a spiky hour is a few
 * hundred segments and a steady one is exactly the single segment it always was.
 */
export function patternSegments(pattern: LoadPattern, base: number, options: PatternOptions): PatternResult {
  const problem = checkPattern(pattern);
  if (problem !== null) return { ok: false, error: problem };

  const from = options.from;
  const end = from + (options.horizon ?? PATTERN_HORIZON);
  const segments: LoadSegment[] = [];
  let weighted = 0;
  let peak = 0;

  // `rateAt` gives the rate from `at` up to the next boundary it reports.
  const lay = (rateAt: (at: number) => { rate: number; until: number }): string | null => {
    let at = from;
    while (at < end) {
      const { rate, until } = rateAt(at);
      if (!Number.isFinite(rate)) {
        return `The formula gives ${String(rate)} at t = ${Math.floor(at)} s. It has to give a number.`;
      }
      const clamped = Math.max(0, rate);
      if (clamped > options.limit) {
        return `This peaks at ${round(clamped)}/s at t = ${Math.floor(at)} s. The most this page will run is ${round(options.limit)}/s.`;
      }
      const stop = Math.min(until, end);
      // A boundary that lands on `at` by float rounding would stall this loop.
      if (!(stop > at)) return "That pattern's timing is too fine to lay out. Use gaps of a tenth of a second or more.";
      const duration = stop - at;
      const last = segments[segments.length - 1];
      if (last !== undefined && last.rate === clamped) {
        segments[segments.length - 1] = { rate: clamped, duration: last.duration + duration };
      } else {
        segments.push({ rate: clamped, duration });
      }
      weighted += clamped * duration;
      peak = Math.max(peak, clamped);
      at = stop;
    }
    return null;
  };

  // Which window of length `width` contains `at`, tolerating float error at the
  // boundary so `at` landing a hair below one never repeats the window it closed.
  const windowOf = (at: number, width: number): number => Math.floor(at / width + 1e-9);

  let error: string | null = null;
  switch (pattern.kind) {
    case "steady":
      error = lay(() => ({ rate: base, until: end }));
      break;

    case "spiky": {
      const quiet = pattern.every - pattern.lasting;
      error = lay((at) => {
        const start = windowOf(at, pattern.every) * pattern.every;
        const spikeAt = start + quiet;
        return at < spikeAt
          ? { rate: base, until: spikeAt }
          : { rate: base * pattern.height, until: start + pattern.every };
      });
      break;
    }

    case "random": {
      // Drawn in order from window 0 on, whatever `from` is, so window k gets the
      // same rate however many times the slider was dragged before reaching it.
      const stream = createSubstreamSource(options.seed).stream("__load__", "pattern");
      const draws: number[] = [];
      const factorFor = (window: number): number => {
        while (draws.length <= window) draws.push(1 + pattern.spread * (2 * stream.nextUnit() - 1));
        return draws[window] as number;
      };
      error = lay((at) => {
        const window = windowOf(at, pattern.every);
        return { rate: base * factorFor(window), until: (window + 1) * pattern.every };
      });
      break;
    }

    case "formula": {
      const compiled = compileFormula(pattern.text);
      if (!compiled.ok) return { ok: false, error: compiled.error };
      error = lay((at) => {
        const second = windowOf(at, FORMULA_STEP) * FORMULA_STEP;
        return { rate: compiled.evaluate(second, base), until: second + FORMULA_STEP };
      });
      break;
    }
  }

  if (error !== null) return { ok: false, error };
  const span = end - from;
  return { ok: true, segments, mean: span > 0 ? weighted / span : 0, peak };
}

function round(rate: number): number {
  return rate >= 10 ? Math.round(rate) : Number(rate.toFixed(1));
}

/** The pattern in a few words, for the change chips. */
export function describePattern(pattern: LoadPattern): string {
  switch (pattern.kind) {
    case "steady":
      return "steady";
    case "spiky":
      return `spikes of ${pattern.height}× for ${pattern.lasting} s every ${pattern.every} s`;
    case "random":
      return `random ±${Math.round(pattern.spread * 100)}%, new rate every ${pattern.every} s`;
    case "formula":
      return pattern.text.trim();
  }
}

/** What the pattern does to the load, in the units the room reads. */
export function summarizePattern(result: { mean: number; peak: number }): string {
  return `Averages ${round(result.mean)}/s and peaks at ${round(result.peak)}/s over the next hour.`;
}
