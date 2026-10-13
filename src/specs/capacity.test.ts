import { describe, expect, it } from "vitest";
import {
  capacityOf,
  capacityUnit,
  describeCapacity,
  hasCapacity,
  parseCapacity,
  withCapacity,
} from "./capacity.ts";
import type { PartialComponentSpec } from "./format.ts";

const db: PartialComponentSpec = {
  concurrency: 1,
  service: { policy: "exponential", mean: 0.02 },
  queue: { policy: "fifo", capacity: 30 },
};

describe("reading a capacity off a spec", () => {
  it("states the sustained rate a component can serve", () => {
    // One connection, 20 ms a query: about fifty a second, which is the number
    // a reviewer would say out loud about this database.
    expect(capacityOf("datastore", db)?.perSecond).toBeCloseTo(50, 10);
  });

  it("counts every server", () => {
    const tier: PartialComponentSpec = { concurrency: 3, service: { policy: "fixed", mean: 0.02 } };
    expect(capacityOf("service", tier)?.perSecond).toBeCloseTo(150, 10);
  });

  it("reads through per-kind defaults rather than demanding a full spec", () => {
    // A datastore dropped on the canvas has a capacity before anyone types one.
    const reading = capacityOf("datastore", {});
    expect(reading?.concurrency).toBe(10);
    expect(reading?.perSecond).toBeCloseTo(1000, 10);
  });

  it("has none for a component that does no work", () => {
    // A balancer routes; it has no service time to convert, and offering a
    // capacity knob for one would invent a number the model never reads.
    expect(hasCapacity("balancer")).toBe(false);
    expect(capacityOf("balancer", { balancer: { policy: "round-robin" } })).toBeNull();
  });

  it("calls instant service unbounded rather than dividing by zero", () => {
    const reading = capacityOf("cache", { concurrency: 4, service: { policy: "fixed", mean: 0 } });
    expect(reading?.perSecond).toBe(Number.POSITIVE_INFINITY);
    expect(describeCapacity(reading!)).toMatch(/instant/i);
  });

  it("names the servers the way the component's kind would", () => {
    expect(capacityUnit("datastore", 1)).toBe("connection");
    expect(capacityUnit("datastore", 10)).toBe("connections");
    expect(capacityUnit("service", 2)).toBe("servers");
    expect(capacityUnit("queue", 4)).toBe("consumers");
  });
});

describe("setting a capacity", () => {
  it("round-trips: what you asked for is what it reads back", () => {
    for (const rate of [1, 12.5, 50, 800, 10_000]) {
      const next = withCapacity("datastore", db, rate);
      expect(capacityOf("datastore", next)?.perSecond).toBeCloseTo(rate, 6);
    }
  });

  it("changes the service time and nothing else", () => {
    const next = withCapacity("datastore", db, 80);

    expect(next.service?.mean).toBeCloseTo(0.0125, 10);
    // The policy is a modelling choice, not a unit — a knob must not silently
    // turn a variable service time into a metronome.
    expect(next.service?.policy).toBe("exponential");
    expect(next.queue).toEqual(db.queue);
    expect(next.concurrency).toBe(1);
  });

  it("does not mutate the spec it was given", () => {
    withCapacity("datastore", db, 500);
    expect(db.service?.mean).toBe(0.02);
  });

  it("divides the rate across the servers that share it", () => {
    const tier: PartialComponentSpec = { concurrency: 4, service: { policy: "fixed", mean: 0.02 } };
    // 200/s over four servers is 50/s each: 20 ms of work per request.
    expect(withCapacity("service", tier, 200).service?.mean).toBeCloseTo(0.02, 10);
  });

  it("refuses a rate that is not a rate", () => {
    for (const bad of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => withCapacity("datastore", db, bad)).toThrow(/per second/i);
    }
  });

  it("refuses a kind that has no service time", () => {
    expect(() => withCapacity("balancer", {}, 50)).toThrow(/balancer/i);
  });
});

describe("what the knob shows", () => {
  it("prints the conversion, so the derived number is never hidden", () => {
    const reading = capacityOf("datastore", db)!;
    expect(describeCapacity(reading)).toBe("50/s ⇒ 20 ms × 1 connection");
  });

  it("scales the unit to the service time rather than printing zero", () => {
    const fast = capacityOf("cache", { concurrency: 1, service: { policy: "fixed", mean: 0.0002 } })!;
    expect(describeCapacity(fast)).toMatch(/200 µs/);

    const slow = capacityOf("datastore", { concurrency: 1, service: { policy: "fixed", mean: 2.5 } })!;
    expect(describeCapacity(slow)).toMatch(/2\.5 s/);
  });
});

describe("reading what somebody typed", () => {
  it("takes the rate on its own or with its unit", () => {
    expect(parseCapacity("50")).toEqual({ ok: true, perSecond: 50 });
    expect(parseCapacity(" 50/s ")).toEqual({ ok: true, perSecond: 50 });
    expect(parseCapacity("1500 rps")).toEqual({ ok: true, perSecond: 1500 });
    expect(parseCapacity("12.5")).toEqual({ ok: true, perSecond: 12.5 });
  });

  it("says what is wrong rather than falling back to a number nobody chose", () => {
    for (const bad of ["", "   ", "fast", "-4", "0"]) {
      const result = parseCapacity(bad);
      expect(result.ok).toBe(false);
      expect(result.ok === false && result.error.length).toBeGreaterThan(0);
    }
  });
});
