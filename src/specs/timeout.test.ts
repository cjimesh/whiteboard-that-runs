import { describe, expect, it } from "vitest";
import { describeTimeout, hasTimeout, parseTimeout, timeoutOf, withTimeout } from "./timeout.ts";
import { validateSpec, type PartialComponentSpec } from "./format.ts";

const api: PartialComponentSpec = {
  concurrency: 200,
  service: { policy: "fixed", mean: 0.002 },
  timeout: { policy: "fixed", after: 0.25 },
  retry: { policy: "exponential", attempts: 3, delay: 0.05, factor: 2, maxDelay: 5 },
};

describe("reading a timeout", () => {
  it("states it in the unit people say it in", () => {
    expect(timeoutOf("service", api)).toEqual({ policy: "fixed", milliseconds: 250 });
  });

  it("belongs only to components that call something and wait", () => {
    expect(hasTimeout("service")).toBe(true);
    // A datastore is the thing being waited *on*; it has no downstream call of
    // its own, so a timeout on it would be a setting that does nothing.
    expect(hasTimeout("datastore")).toBe(false);
    expect(hasTimeout("balancer")).toBe(false);
    expect(timeoutOf("datastore", {})).toBeNull();
  });

  it("reports a component that never gives up", () => {
    const patient = withTimeout("service", api, null);
    expect(timeoutOf("service", patient)?.policy).toBe("none");
  });
});

describe("setting a timeout", () => {
  it("stores milliseconds as the seconds the engine reads", () => {
    expect(withTimeout("service", api, 1000).timeout).toEqual({ policy: "fixed", after: 1 });
    expect(withTimeout("service", api, 40).timeout?.after).toBeCloseTo(0.04, 10);
  });

  it("changes the timeout and nothing else", () => {
    const next = withTimeout("service", api, 1000);
    expect(next.retry).toEqual(api.retry);
    expect(next.service).toEqual(api.service);
    expect(next.concurrency).toBe(200);
  });

  it("keeps a usable duration when switched off, so it can be switched back on", () => {
    const off = withTimeout("service", api, null);
    expect(off.timeout?.policy).toBe("none");
    // The spec format carries every policy's parameters precisely so a live flip
    // back does not have to invent one mid-demo.
    expect(off.timeout?.after).toBe(0.25);
    expect(validateSpec("service", off).ok).toBe(true);
  });

  it("produces a spec the engine will accept", () => {
    for (const ms of [1, 250, 5000]) {
      expect(validateSpec("service", withTimeout("service", api, ms)).ok).toBe(true);
    }
  });

  it("refuses a duration that is not one", () => {
    for (const bad of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => withTimeout("service", api, bad)).toThrow(/milliseconds/i);
    }
  });

  it("does not mutate the spec it was given", () => {
    withTimeout("service", api, 999);
    expect(api.timeout?.after).toBe(0.25);
  });
});

describe("reading what somebody typed", () => {
  it("takes plain milliseconds, or a unit", () => {
    expect(parseTimeout("250")).toEqual({ ok: true, milliseconds: 250 });
    expect(parseTimeout("250ms")).toEqual({ ok: true, milliseconds: 250 });
    expect(parseTimeout(" 1s ")).toEqual({ ok: true, milliseconds: 1000 });
    expect(parseTimeout("1.5 s")).toEqual({ ok: true, milliseconds: 1500 });
  });

  it("understands switching it off", () => {
    for (const text of ["off", "none", "never"]) {
      expect(parseTimeout(text)).toEqual({ ok: true, milliseconds: null });
    }
  });

  it("says what is wrong rather than guessing", () => {
    for (const bad of ["", "soon", "-4", "0"]) {
      const result = parseTimeout(bad);
      expect(result.ok).toBe(false);
      expect(result.ok === false && result.error.length).toBeGreaterThan(0);
    }
  });
});

describe("what the knob shows", () => {
  it("says what the setting does, not just what it is", () => {
    expect(describeTimeout({ policy: "fixed", milliseconds: 250 })).toBe(
      "Gives up on a slow call after 250 ms, then retries.",
    );
    expect(describeTimeout({ policy: "fixed", milliseconds: 1500 })).toMatch(/1\.5 s/);
    expect(describeTimeout({ policy: "none", milliseconds: 250 })).toMatch(/never gives up/i);
  });
});
