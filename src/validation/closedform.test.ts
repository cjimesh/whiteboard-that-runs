import { describe, expect, it } from "vitest";
import {
  erlangB,
  erlangC,
  md1MeanSojourn,
  mm1MeanResident,
  mm1MeanSojourn,
  mmcMeanResident,
  mmcMeanSojourn,
  mmcMeanWait,
  relativeError,
  relaxationTime,
  utilization,
} from "./closedform.ts";

/**
 * The closed forms check each other.
 *
 * These are the numbers the simulator is measured against, so an error here would
 * not show up as a failure — it would show up as a simulator that "passes
 * validation" against the wrong target, which is worse than no suite at all. So
 * the formulas are pinned three ways: against analytic identities that must hold
 * exactly, against a published Erlang C value, and against each other where two
 * of them describe the same queue.
 */

describe("Erlang B and C", () => {
  it("matches the published Erlang C value for c = 3 at 2 erlangs", () => {
    // The textbook worked example: C(3, 2) = 4/9 exactly.
    expect(erlangC(3, 2, 1)).toBeCloseTo(4 / 9, 10);
  });

  it("gives a waiting probability of exactly rho at a single server", () => {
    // In M/M/1 the chance of finding the server busy *is* the utilization. The
    // recursion has to reproduce that identity, not merely come close.
    for (const rho of [0.1, 0.5, 0.8, 0.95]) {
      expect(erlangC(1, rho, 1)).toBeCloseTo(rho, 12);
    }
  });

  it("makes blocking fall as servers are added", () => {
    const blocking = [1, 2, 3, 4, 8].map((c) => erlangB(c, 3));
    for (let i = 1; i < blocking.length; i += 1) {
      expect(blocking[i] as number).toBeLessThan(blocking[i - 1] as number);
    }
  });

  it("saturates to certain waiting at or above capacity", () => {
    expect(erlangC(4, 100, 25)).toBe(1);
    expect(erlangC(4, 120, 25)).toBe(1);
  });
});

describe("M/M/c reduces to M/M/1", () => {
  it("agrees exactly with the single-server formula at c = 1", () => {
    // Algebraically identical: C/(mu - lambda) + 1/mu collapses to 1/(mu - lambda).
    for (const [lambda, mu] of [
      [5, 10],
      [20, 25],
      [45, 50],
      [47.5, 50],
    ] as const) {
      expect(mmcMeanSojourn(lambda, mu, 1)).toBeCloseTo(mm1MeanSojourn(lambda, mu), 12);
      expect(mmcMeanResident(lambda, mu, 1)).toBeCloseTo(mm1MeanResident(lambda, mu), 10);
    }
  });

  it("splits sojourn into waiting plus service", () => {
    expect(mmcMeanSojourn(80, 25, 4)).toBeCloseTo(mmcMeanWait(80, 25, 4) + 1 / 25, 12);
  });

  it("puts the c = 4 example where the recursion says it should", () => {
    // Worked through by hand: a = 3.2, B(4) = 0.2281, C = 0.5964,
    // Wq = 0.5964 / 20 = 0.02982, W = 0.06982.
    expect(erlangC(4, 80, 25)).toBeCloseTo(0.5964, 3);
    expect(mmcMeanSojourn(80, 25, 4)).toBeCloseTo(0.06982, 4);
  });
});

describe("Little's Law holds inside the closed forms", () => {
  it("relates L and W for every case the suite checks", () => {
    const cases = [
      { lambda: 25, mu: 50, servers: 1 },
      { lambda: 45, mu: 50, servers: 1 },
      { lambda: 80, mu: 25, servers: 4 },
      { lambda: 68, mu: 10, servers: 8 },
    ];
    for (const { lambda, mu, servers } of cases) {
      const expected = lambda * mmcMeanSojourn(lambda, mu, servers);
      expect(mmcMeanResident(lambda, mu, servers)).toBeCloseTo(expected, 10);
    }
  });

  it("gives the single-server L its standard form", () => {
    expect(mm1MeanResident(40, 50)).toBeCloseTo(0.8 / 0.2, 10);
    expect(mm1MeanResident(45, 50)).toBeCloseTo(9, 10);
  });
});

describe("instability and utilization", () => {
  it("reports infinite waiting at or beyond capacity rather than a negative number", () => {
    expect(mm1MeanSojourn(50, 50)).toBe(Number.POSITIVE_INFINITY);
    expect(mm1MeanSojourn(60, 50)).toBe(Number.POSITIVE_INFINITY);
    expect(mm1MeanResident(60, 50)).toBe(Number.POSITIVE_INFINITY);
    expect(mmcMeanWait(120, 25, 4)).toBe(Number.POSITIVE_INFINITY);
    expect(relaxationTime(50, 50)).toBe(Number.POSITIVE_INFINITY);
  });

  it("divides load across servers", () => {
    expect(utilization(80, 25, 4)).toBeCloseTo(0.8, 12);
    expect(utilization(45, 50)).toBeCloseTo(0.9, 12);
  });
});

describe("relaxation time", () => {
  it("grows as the inverse square of the headroom", () => {
    // This is why the run budget has to scale: going from rho 0.5 to 0.9 makes the
    // queue 25x slower to settle, and 0.5 to 0.95 makes it 100x slower.
    const half = relaxationTime(25, 50);
    expect(relaxationTime(45, 50) / half).toBeCloseTo(25, 6);
    expect(relaxationTime(47.5, 50) / half).toBeCloseTo(100, 6);
  });
});

describe("M/D/1, the deliberate mismatch", () => {
  it("sits well below M/M/1 at the same load, far outside any declared tolerance", () => {
    // Constant service time halves the waiting term. The suite's self-check points
    // the harness at this queue while checking the M/M/1 formula, and this is why
    // that has to be caught: the gap is about 40%, not a rounding difference.
    const md1 = md1MeanSojourn(20, 25);
    const mm1 = mm1MeanSojourn(20, 25);

    expect(md1).toBeCloseTo(0.12, 10);
    expect(mm1).toBeCloseTo(0.2, 10);
    expect(relativeError(md1, mm1)).toBeGreaterThan(0.3);
  });
});

describe("relativeError", () => {
  it("is symmetric in magnitude and zero on an exact match", () => {
    expect(relativeError(0.2, 0.2)).toBe(0);
    expect(relativeError(0.21, 0.2)).toBeCloseTo(0.05, 12);
    expect(relativeError(0.19, 0.2)).toBeCloseTo(0.05, 12);
  });

  it("does not divide by zero", () => {
    expect(relativeError(0, 0)).toBe(0);
    expect(relativeError(1, 0)).toBe(Number.POSITIVE_INFINITY);
  });
});
