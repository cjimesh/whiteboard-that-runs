import { describe, expect, it } from "vitest";
import { createSubstreamSource } from "./prng.ts";

/**
 * Randomness is the one thing in the engine that could quietly break replay, so
 * it is counter-based rather than stateful-shared: draw *i* of a substream is a
 * pure function of (seed, node, purpose, i). Nothing another component does can
 * shift it, which is what the delta toggle needs — same load realisation, same
 * per-node draws, only the structure differs.
 */

describe("substream independence", () => {
  it("gives the same sequence for the same key, every time", () => {
    const a = createSubstreamSource("seed").stream("svc", "service");
    const b = createSubstreamSource("seed").stream("svc", "service");
    const draw = (s: { nextUnit(): number }): number[] => Array.from({ length: 10 }, () => s.nextUnit());

    expect(draw(a)).toEqual(draw(b));
  });

  it("gives different sequences for different nodes, purposes and seeds", () => {
    const source = createSubstreamSource("seed");
    const take = (nodeId: string, purpose: string): number[] =>
      Array.from({ length: 6 }, () => source.stream(nodeId, purpose).nextUnit());

    // Fresh streams each call would repeat, so pull them once and compare runs.
    const one = source.stream("a", "service");
    const two = source.stream("b", "service");
    const three = source.stream("a", "arrival");
    const other = createSubstreamSource("other-seed").stream("a", "service");

    const draw = (s: { nextUnit(): number }): number[] => Array.from({ length: 6 }, () => s.nextUnit());
    const [s1, s2, s3, s4] = [draw(one), draw(two), draw(three), draw(other)];

    expect(s1).not.toEqual(s2);
    expect(s1).not.toEqual(s3);
    expect(s1).not.toEqual(s4);
    expect(take("a", "service")).toHaveLength(6);
  });

  it("returns the same stream object for a repeated key, so the counter advances once", () => {
    const source = createSubstreamSource("seed");
    const first = source.stream("a", "service");
    const second = source.stream("a", "service");

    expect(second).toBe(first);
    const x = first.nextUnit();
    const y = second.nextUnit();
    expect(y).not.toBe(x);
    expect(source.drawCount("a", "service")).toBe(2);
  });
});

describe("distribution shape", () => {
  it("draws unit values strictly inside (0, 1)", () => {
    const stream = createSubstreamSource("range").stream("n", "p");
    for (let i = 0; i < 20_000; i += 1) {
      const u = stream.nextUnit();
      expect(u).toBeGreaterThan(0);
      expect(u).toBeLessThan(1);
    }
  });

  it("is roughly uniform across deciles", () => {
    const stream = createSubstreamSource("uniform").stream("n", "p");
    const bins = new Array<number>(10).fill(0);
    const n = 100_000;
    for (let i = 0; i < n; i += 1) {
      const bin = Math.min(9, Math.floor(stream.nextUnit() * 10));
      bins[bin] = (bins[bin] as number) + 1;
    }

    for (const count of bins) {
      expect(count).toBeGreaterThan(n * 0.09);
      expect(count).toBeLessThan(n * 0.11);
    }
  });

  it("draws exponentials whose mean matches 1/rate", () => {
    // The M/M/1 checks in the validation suite are only exact if interarrival
    // and service draws really are exponential, so this is load-bearing.
    const stream = createSubstreamSource("exp").stream("n", "p");
    const rate = 4;
    const n = 200_000;
    let sum = 0;
    let sumSq = 0;
    // Counted rather than asserted per draw: 200k `expect` calls cost seconds and
    // pushed this test over the default timeout whenever the suite was competing
    // for CPU. One assertion on the count says exactly the same thing.
    let nonPositive = 0;
    for (let i = 0; i < n; i += 1) {
      const x = stream.nextExponential(rate);
      if (!(x > 0)) nonPositive += 1;
      sum += x;
      sumSq += x * x;
    }
    expect(nonPositive).toBe(0);

    const mean = sum / n;
    expect(mean).toBeGreaterThan(0.97 / rate);
    expect(mean).toBeLessThan(1.03 / rate);
    // Exponential variance equals mean squared; catches a uniform draw wearing
    // the right average.
    const variance = sumSq / n - mean * mean;
    expect(variance / (mean * mean)).toBeGreaterThan(0.9);
    expect(variance / (mean * mean)).toBeLessThan(1.1);
  });
});
