// @vitest-environment node
/**
 * A dependency call's own timeout and retry.
 *
 * The case this exists for is a classic failure mode: every read retried once on
 * timeout, against a single-threaded store. The claims under test are the ones that make that a storm
 * rather than a slowdown — an abandoned attempt keeps occupying the spine, so a
 * retry is extra load rather than a second chance — and the ones that make it
 * fixable in a room: the policy can be changed mid-run, and the change replays.
 */
import { describe, expect, it } from "vitest";
import { createModelSimulation } from "./registry.ts";
import { validateCallPolicy } from "./call-policy.ts";
import { validateTimeline, type Timeline } from "../engine/timeline.ts";

const RETRY_ONCE = { policy: "fixed", attempts: 1, delay: 0, factor: 1, maxDelay: 0 };
const TIGHT = { policy: "fixed", after: 0.01 };

/**
 * One service calling a single-threaded spine once per request, at 80% of what
 * the spine can do — 200/s against 250/s.
 *
 * An M/M/1 queue at ρ = 0.8 has a mean sojourn of 20 ms, so a 10 ms timeout
 * gives up on most calls. That is the point: the spine is near its knee, which
 * is where a retry storm needs it to be.
 */
function spine(policy?: Record<string, unknown>, capacity = 100_000): Timeline {
  return {
    model: {
      entryId: "api",
      nodes: [
        {
          id: "api",
          kind: "service",
          spec: {
            concurrency: 2000,
            service: { policy: "fixed", mean: 0.002 },
            queue: { policy: "fifo", capacity: 100_000 },
          },
        },
        {
          id: "redis",
          kind: "datastore",
          spec: {
            concurrency: 1,
            service: { policy: "exponential", mean: 0.004 },
            queue: { policy: "fifo", capacity },
          },
        },
      ],
      edges: [{ from: "api", to: "redis", kind: "call", times: 1, ...(policy === undefined ? {} : { policy }) }],
    },
    load: [{ rate: 200, duration: 400 }],
    seed: "call-policy",
    mutations: [],
    bucketWidth: 1,
  };
}

function window(timeline: Timeline, from: number, to: number) {
  const sim = createModelSimulation(timeline);
  sim.runUntil(to);
  return summarise(sim.series(), from);
}

function summarise(series: ReturnType<ReturnType<typeof createModelSimulation>["series"]>, from: number) {
  const buckets = series.filter((bucket) => bucket.start >= from);
  const mean = (read: (bucket: (typeof buckets)[number]) => number): number =>
    buckets.reduce((total, bucket) => total + read(bucket), 0) / buckets.length;
  return {
    goodput: mean((b) => b.system.completions),
    spineArrivals: mean((b) => b.nodes["redis"]?.arrivals ?? 0),
    spineUtilization: mean((b) => b.nodes["redis"]?.utilization ?? 0),
    callerRetries: mean((b) => b.nodes["api"]?.retries ?? 0),
    callerTimeouts: mean((b) => b.nodes["api"]?.timeouts ?? 0),
    spineRetries: mean((b) => b.nodes["redis"]?.retries ?? 0),
  };
}

describe("a dependency call with no policy", () => {
  it("changes nothing at all, authored or absent", () => {
    // Every model drawn before this existed has to run to the same digit, or the
    // numbers already quoted from them would quietly move.
    const run = (timeline: Timeline) => {
      const sim = createModelSimulation(timeline);
      sim.runUntil(120);
      return sim.series();
    };
    const absent = run(spine());
    const explicitNone = run(
      spine({
        timeout: { policy: "none", after: 0.01 },
        retry: { policy: "none", attempts: 3, delay: 0.1, factor: 2, maxDelay: 1 },
      }),
    );

    expect(explicitNone).toEqual(absent);
  });
});

describe("a timeout on a dependency call", () => {
  it("gives up as often as queueing theory says, without adding load", () => {
    // No retry: an abandoned call is still served, so the spine sees exactly the
    // offered rate, and a request survives only if its call's sojourn beats the
    // timeout. For M/M/1 that is 1 − e^(−(μ−λ)T) = 1 − e^(−0.5) ≈ 39%.
    const tight = window(spine({ timeout: TIGHT }), 100, 300);
    const expected = 200 * (1 - Math.exp(-(250 - 200) * 0.01));

    expect(tight.spineArrivals / 200).toBeGreaterThan(0.97);
    expect(tight.spineArrivals / 200).toBeLessThan(1.03);
    expect(tight.goodput / expected).toBeGreaterThan(0.95);
    expect(tight.goodput / expected).toBeLessThan(1.05);
  });
});

describe("a retry on a dependency call", () => {
  it("turns a spine near its knee into a retry storm", () => {
    // A bounded spine, so a run past the knee does not spend its time shuffling
    // a backlog of tens of thousands; the storm reads the same either way.
    const calm = window(spine(undefined, 1000), 100, 300);
    const storm = window(spine({ timeout: TIGHT, retry: RETRY_ONCE }, 1000), 100, 300);

    // Without the retry, everything offered is served and the spine has room.
    expect(calm.goodput).toBeGreaterThan(195);
    expect(calm.spineUtilization).toBeLessThan(0.85);

    // With it, every call is asked twice — the abandoned first attempt is still
    // in the spine's queue — the spine saturates, and nothing gets through.
    expect(storm.spineArrivals / 200).toBeGreaterThan(1.95);
    expect(storm.spineUtilization).toBeGreaterThan(0.99);
    expect(storm.goodput).toBeLessThan(1);
  }, 30_000);

  it("is held to its budget: retries at most that share of requests", () => {
    // The same storm, with one retry allowed per ten requests. Without a budget
    // the caller retries ~200/s; with it, ~20/s, and the spine is asked roughly
    // 1.1× rather than 2× — the cap a budget exists to put on a storm.
    const budgeted = window(spine({ timeout: TIGHT, retry: { ...RETRY_ONCE, budget: 0.1 } }, 1000), 100, 300);

    expect(budgeted.callerRetries).toBeGreaterThan(15);
    expect(budgeted.callerRetries).toBeLessThan(21);
    expect(budgeted.spineArrivals / 200).toBeLessThan(1.11);
  }, 30_000);

  it("is counted on the caller, which is the component doing it", () => {
    const storm = window(spine({ timeout: TIGHT, retry: RETRY_ONCE }, 1000), 100, 300);

    expect(storm.callerTimeouts).toBeGreaterThan(190);
    expect(storm.callerRetries).toBeGreaterThan(190);
    expect(storm.spineRetries).toBe(0);
  }, 30_000);

  it("asks again after a refusal, not only after a timeout", () => {
    // A spine with no buffer at all refuses whatever arrives while it is busy —
    // Erlang B with one server, so ρ/(1+ρ) ≈ 29% of first tries at 100/s. A short
    // wait and a few more tries recover most of those.
    const lossy = (policy?: Record<string, unknown>): Timeline => ({
      ...spine(policy, 0),
      load: [{ rate: 100, duration: 400 }],
    });
    const refused = window(lossy(), 100, 300);
    const persistent = window(
      lossy({ retry: { policy: "fixed", attempts: 3, delay: 0.01, factor: 1, maxDelay: 0 } }),
      100,
      300,
    );

    expect(refused.goodput).toBeLessThan(75);
    expect(persistent.goodput).toBeGreaterThan(90);
    expect(persistent.callerRetries).toBeGreaterThan(0);
  });
});

describe("changing a call's policy mid-run", () => {
  function fixedLive() {
    // A bounded spine, so the backlog the storm built is small enough to drain.
    const sim = createModelSimulation(spine({ timeout: TIGHT, retry: RETRY_ONCE }, 1000));
    sim.runUntil(60);
    sim.record({ kind: "set-call", from: "api", to: "redis", policy: { timeout: TIGHT } });
    sim.runUntil(300);
    return sim;
  }

  it("recovers the storm when the retry is taken away", () => {
    const sim = fixedLive();
    const before = summarise(sim.series().filter((bucket) => bucket.start < 60), 30);
    const after = summarise(sim.series(), 120);

    expect(before.goodput).toBeLessThan(1);
    // Back to what a timeout without a retry gives at this load — see the
    // queueing-theory test above.
    expect(after.goodput).toBeGreaterThan(70);
    expect(after.spineArrivals / 200).toBeLessThan(1.03);
  }, 30_000);

  it("replays to the same digit", () => {
    const live = fixedLive();
    const replay = createModelSimulation(live.recorded());
    replay.runUntil(300);

    expect(replay.series()).toEqual(live.series());
  }, 30_000);

  it("refuses a change to something that is not a dependency call", () => {
    const sim = createModelSimulation(spine());
    sim.runUntil(1);

    expect(() => sim.record({ kind: "set-call", from: "redis", to: "api", policy: {} })).toThrow(
      /"redis" → "api", which is not a dependency/,
    );
  });
});

describe("what a call policy may say", () => {
  it("is refused on a hand-off, which has the sender's own timeout and retry", () => {
    const timeline = spine();
    const handOff: Timeline = {
      ...timeline,
      model: { ...timeline.model, edges: [{ from: "api", to: "redis", policy: { timeout: TIGHT } }] },
    };

    const validation = validateTimeline(handOff);
    expect(validation.ok).toBe(false);
    expect(validation.errors.join("\n")).toMatch(/hands work on, so it has no call policy/);
  });

  it("names a concern a call does not read", () => {
    const validation = validateCallPolicy({ hold: { policy: "fixed", mean: 1 } });

    expect(validation.ok).toBe(false);
    expect(validation.errors.join("\n")).toMatch(/does not use "hold"/);
  });

  it("stops the run, naming the call, rather than ignore a policy it cannot read", () => {
    const sim = createModelSimulation(spine({ retry: { policy: "sometimes" } }));

    expect(() => sim.runUntil(5)).toThrow(/the call "api" → "redis" has an invalid call policy/);
  });
});
