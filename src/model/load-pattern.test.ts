import { describe, expect, it } from "vitest";
import { DEFAULT_PATTERNS, patternSegments, summarizePattern, type LoadPattern } from "./load-pattern.ts";
import type { LoadSegment } from "../engine/timeline.ts";

const options = { from: 0, seed: "seed", limit: 10_000 };

function lay(pattern: LoadPattern, base: number, overrides: Partial<typeof options & { horizon: number }> = {}) {
  const result = patternSegments(pattern, base, { ...options, ...overrides });
  if (!result.ok) throw new Error(result.error);
  return result;
}

/** The rate a segment list offers at sim time `at`, given where it starts. */
function rateAt(segments: readonly LoadSegment[], from: number, at: number): number {
  let start = from;
  for (const segment of segments) {
    if (at < start + segment.duration) return segment.rate;
    start += segment.duration;
  }
  return 0;
}

const total = (segments: readonly LoadSegment[]): number =>
  segments.reduce((sum, segment) => sum + segment.duration, 0);

describe("steady load", () => {
  it("is the single hour-long segment the slider has always recorded", () => {
    expect(lay(DEFAULT_PATTERNS.steady, 44).segments).toEqual([{ rate: 44, duration: 3600 }]);
  });
});

describe("spiky load", () => {
  const spiky: LoadPattern = { kind: "spiky", height: 3, every: 20, lasting: 2 };

  it("sits at the base rate and spikes at the end of every period", () => {
    const { segments } = lay(spiky, 10);
    expect(rateAt(segments, 0, 0)).toBe(10);
    expect(rateAt(segments, 0, 17.9)).toBe(10);
    expect(rateAt(segments, 0, 18)).toBe(30);
    expect(rateAt(segments, 0, 19.9)).toBe(30);
    expect(rateAt(segments, 0, 20)).toBe(10);
    expect(rateAt(segments, 0, 38.5)).toBe(30);
    expect(total(segments)).toBeCloseTo(3600);
  });

  it("reports its average and peak", () => {
    const result = lay(spiky, 10);
    expect(result.peak).toBe(30);
    expect(result.mean).toBeCloseTo(12); // 18 s at 10 and 2 s at 30, per 20 s
  });

  it("keeps the spikes where they were when it is laid out mid-run", () => {
    // Dragging the slider at t = 25 must not move the next spike under the driver's hand.
    const { segments } = lay(spiky, 10, { from: 25 });
    expect(rateAt(segments, 25, 25)).toBe(10);
    expect(rateAt(segments, 25, 37.9)).toBe(10);
    expect(rateAt(segments, 25, 38)).toBe(30);
    expect(total(segments)).toBeCloseTo(3600);
  });

  it("refuses a spike that is longer than its gap", () => {
    const result = patternSegments({ kind: "spiky", height: 3, every: 5, lasting: 5 }, 10, options);
    expect(result).toMatchObject({ ok: false });
  });
});

describe("random load", () => {
  const random: LoadPattern = { kind: "random", spread: 0.5, every: 5 };

  it("stays within the swing and averages near the base", () => {
    const result = lay(random, 40);
    for (const segment of result.segments) {
      expect(segment.rate).toBeGreaterThanOrEqual(20);
      expect(segment.rate).toBeLessThanOrEqual(60);
    }
    expect(result.mean).toBeGreaterThan(38);
    expect(result.mean).toBeLessThan(42);
    expect(new Set(result.segments.map((segment) => segment.rate)).size).toBeGreaterThan(100);
  });

  it("is the same load for the same seed, wherever it is laid out from", () => {
    const fromZero = lay(random, 40).segments;
    const fromLater = lay(random, 40, { from: 102 }).segments;
    for (const at of [102, 104.9, 105, 333, 1000]) {
      expect(rateAt(fromLater, 102, at)).toBe(rateAt(fromZero, 0, at));
    }
  });

  it("is different load on a different seed", () => {
    expect(lay(random, 40, { seed: "other" }).segments).not.toEqual(lay(random, 40).segments);
  });
});

describe("a formula", () => {
  it("is read once a second in sim time", () => {
    const { segments } = lay({ kind: "formula", text: "t < 30 ? base : base * 3" }, 10);
    expect(segments).toEqual([
      { rate: 10, duration: 30 },
      { rate: 30, duration: 3570 },
    ]);
  });

  it("follows a curve", () => {
    const { segments } = lay({ kind: "formula", text: "base * (1 + 0.5 * sin(2 * pi * t / 60))" }, 20);
    expect(rateAt(segments, 0, 0)).toBeCloseTo(20);
    expect(rateAt(segments, 0, 15)).toBeCloseTo(30);
    expect(rateAt(segments, 0, 45)).toBeCloseTo(10);
  });

  it("treats a negative rate as no traffic", () => {
    const { segments } = lay({ kind: "formula", text: "t < 10 ? -5 : 10" }, 0);
    expect(segments[0]).toEqual({ rate: 0, duration: 10 });
  });

  it("refuses a rate that is not a number, naming when", () => {
    const result = patternSegments({ kind: "formula", text: "1 / (t - 3)" }, 10, { ...options, limit: Infinity });
    expect(result).toMatchObject({ ok: false });
    expect(!result.ok && result.error).toContain("t = 3");
  });

  it("refuses a rate that would freeze the page", () => {
    const result = patternSegments({ kind: "formula", text: "t > 100 ? 1e9 : base" }, 10, options);
    expect(!result.ok && result.error).toContain("The most this page will run is 10000/s");
  });

  it("passes on a parse error", () => {
    const result = patternSegments({ kind: "formula", text: "base *" }, 10, options);
    expect(!result.ok && result.error).toContain("ends too early");
  });
});

describe("steps", () => {
  const steps: LoadPattern = {
    kind: "steps",
    steps: [
      { rate: 20, duration: 60 },
      { rate: 80, duration: 10 },
      { rate: 20, duration: 60 },
    ],
  };

  it("are the schedule as typed when the slider sits on the first step", () => {
    const result = lay(steps, 20);
    expect(result.segments).toEqual([
      { rate: 20, duration: 60 },
      { rate: 80, duration: 10 },
      { rate: 20, duration: 60 },
    ]);
    expect(result.ends).toBe(130);
    expect(result.span).toBe(130);
  });

  it("move in proportion when the slider moves", () => {
    expect(lay(steps, 30).segments.map((segment) => segment.rate)).toEqual([30, 120, 30]);
  });

  it("pick up mid-schedule, and stop at its end", () => {
    const { segments } = lay(steps, 20, { from: 65 });
    expect(segments).toEqual([
      { rate: 80, duration: 5 },
      { rate: 20, duration: 60 },
    ]);
    expect(lay(steps, 20, { from: 500 }).segments).toEqual([]);
  });

  it("keep two equal steps as two, the way they were typed", () => {
    const twice: LoadPattern = { kind: "steps", steps: [{ rate: 5, duration: 10 }, { rate: 5, duration: 10 }] };
    expect(lay(twice, 5).segments).toHaveLength(2);
  });

  it("measure the slider against the busiest step when the first is quiet", () => {
    const quietStart: LoadPattern = { kind: "steps", steps: [{ rate: 0, duration: 10 }, { rate: 50, duration: 10 }] };
    expect(lay(quietStart, 100).segments.map((segment) => segment.rate)).toEqual([0, 100]);
  });

  it("say when the schedule has run out", () => {
    const result = lay(steps, 20, { from: 500 });
    expect(summarizePattern(result)).toMatch(/schedule has ended/);
    expect(summarizePattern(lay(steps, 20, { from: 65 }))).toMatch(/until the schedule ends at 130 s/);
  });
});
