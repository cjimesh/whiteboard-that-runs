/**
 * Other traffic on a shared component.
 *
 * A model has one source of arrivals, so a Redis that several products lean on
 * runs here with most of its real load missing: it reads as idle, and the tool
 * names something upstream as the constraint. That was the top gap on the list
 * that came back from the review this thing was built for.
 *
 * The contract these tests pin, in order of how much rests on it:
 *
 *  1. Stating other traffic does not move the modelled path's load realisation.
 *     A source has its own arrival substream, so turning the neighbours on and
 *     off changes contention and nothing else. Without this, "the shared spine
 *     costs us 200 ms" and "a different roll of the dice" are the same reading.
 *  2. Other traffic occupies the component and is charged to it — utilization,
 *     queue, hold — because that is the entire point.
 *  3. Other traffic stays off the system totals. A checkout and somebody
 *     else's GET are not two samples of one latency.
 *  4. Traffic that never lands is visible. A source turned away at the door
 *     looks, from the node's side, exactly like a source that was never stated.
 */
import { describe, expect, it } from "vitest";
import { createSimulation } from "./kernel.ts";
import { referenceRegistry } from "./reference-nodes.ts";
import { validateTimeline, type ModelSnapshot, type Timeline, type TrafficSource } from "./timeline.ts";

/** `a` forwards to `b`; `b` is a leaf, which is what other traffic can land on. */
function pair(bSpec: Record<string, unknown> = {}): ModelSnapshot {
  return {
    entryId: "a",
    nodes: [
      { id: "a", kind: "reference", spec: { service: { kind: "fixed", time: 0.002 }, servers: 100 } },
      {
        id: "b",
        kind: "reference",
        spec: { service: { kind: "exponential", rate: 50 }, servers: 4, ...bSpec },
      },
    ],
    edges: [{ from: "a", to: "b" }],
  };
}

function timelineWith(sources: readonly TrafficSource[], model = pair()): Timeline {
  return {
    model: { ...model, sources },
    load: [{ rate: 10, duration: 40 }],
    seed: "other-traffic",
    mutations: [],
    bucketWidth: 1,
  };
}

function run(timeline: Timeline, until = 40) {
  const sim = createSimulation(timeline, referenceRegistry());
  sim.runUntil(until);
  return sim;
}

/** Totals over the whole run, which is how a reading is quoted. */
function totals(sim: ReturnType<typeof run>) {
  const series = sim.series();
  const sum = (pick: (bucket: (typeof series)[number]) => number): number =>
    series.reduce((total, bucket) => total + pick(bucket), 0);
  return {
    systemArrivals: sum((bucket) => bucket.system.arrivals),
    systemCompletions: sum((bucket) => bucket.system.completions),
    systemDrops: sum((bucket) => bucket.system.drops),
    bArrivals: sum((bucket) => bucket.nodes["b"]?.arrivals ?? 0),
    // The reference behavior never declares how many servers it has, so this
    // field reads as mean *busy servers* here rather than a 0–1 utilization —
    // which is λ/μ, and a clean thing to check a stated rate against. The
    // shipped components declare concurrency and report a real utilization.
    bBusyServers:
      series.reduce((total, bucket) => total + (bucket.nodes["b"]?.utilization ?? 0), 0) / series.length,
    sourceArrivals: (id: string) => sum((bucket) => bucket.sources[id]?.arrivals ?? 0),
    sourceCompletions: (id: string) => sum((bucket) => bucket.sources[id]?.completions ?? 0),
    sourceDrops: (id: string) => sum((bucket) => bucket.sources[id]?.drops ?? 0),
  };
}

const NEIGHBOURS: TrafficSource = {
  id: "neighbours",
  name: "everything else on the datastore",
  nodeId: "b",
  rate: 60,
};

describe("stating other traffic leaves the modelled path's dice alone", () => {
  it("is identical to the last digit when the rate is zero", () => {
    // The `hold: none` test's sibling: a feature that is off has to be off, or
    // every model in existence gets a new answer the day the feature ships.
    const without = JSON.stringify(run(timelineWith([])).series());
    const zero = JSON.stringify(run(timelineWith([{ ...NEIGHBOURS, rate: 0 }])).series());
    expect(zero).toBe(without);
  });

  it("does not move a single arrival of the modelled path", () => {
    // Contention changes what happens to those requests. It must not change
    // when they turn up, or a with/without comparison measures the dice.
    const without = run(timelineWith([]));
    const with_ = run(timelineWith([NEIGHBOURS]));

    const arrivalsPerSecond = (sim: ReturnType<typeof run>): number[] =>
      sim.series().map((bucket) => bucket.system.arrivals);

    expect(arrivalsPerSecond(with_)).toEqual(arrivalsPerSecond(without));
    expect(totals(with_).systemArrivals).toBe(totals(without).systemArrivals);
  });

  it("replays a run whose other traffic was turned up mid-run", () => {
    const timeline = timelineWith([NEIGHBOURS]);
    const live: Timeline = {
      ...timeline,
      mutations: [{ at: 12, kind: "set-source-rate", sourceId: "neighbours", rate: 150 }],
    };
    expect(JSON.stringify(run(live).series())).toBe(JSON.stringify(run(live).series()));
  });
});

describe("other traffic is charged to the component it lands on", () => {
  it("adds its arrivals to the node and its load to the node's utilization", () => {
    const without = totals(run(timelineWith([])));
    const with_ = totals(run(timelineWith([NEIGHBOURS])));

    // 40 s at 60/s, Poisson: the count is not exactly 2400 and pinning it would
    // be pinning the seed, so this is the band a rate claim is worth.
    expect(with_.sourceArrivals("neighbours")).toBeGreaterThan(2200);
    expect(with_.sourceArrivals("neighbours")).toBeLessThan(2600);
    expect(with_.bArrivals - without.bArrivals).toBe(with_.sourceArrivals("neighbours"));

    // The finding this exists for: the spine carries the load nobody drew, and
    // it shows. 10/s at a 20 ms mean is 0.2 servers' worth of work; 70/s is 1.4.
    expect(without.bBusyServers).toBeCloseTo(0.2, 1);
    expect(with_.bBusyServers).toBeCloseTo(1.4, 1);
  });

  it("turns a mid-run rate change into contention the node feels", () => {
    const timeline = timelineWith([{ ...NEIGHBOURS, rate: 0 }]);
    const sim = run({
      ...timeline,
      mutations: [{ at: 20, kind: "set-source-rate", sourceId: "neighbours", rate: 150 }],
    });

    const series = sim.series();
    const before = series.slice(5, 19);
    const after = series.slice(25, 39);
    const meanBusyServers = (window: typeof series): number =>
      window.reduce((total, bucket) => total + (bucket.nodes["b"]?.utilization ?? 0), 0) / window.length;

    // 10/s alone, then 160/s, at a 20 ms mean: 0.2 servers' worth, then 3.2.
    expect(meanBusyServers(before)).toBeCloseTo(0.2, 1);
    expect(meanBusyServers(after)).toBeCloseTo(3.2, 0);
  });
});

describe("other traffic stays off the system totals", () => {
  it("counts none of it as an arrival, a completion or a drop of the modelled path", () => {
    const with_ = totals(run(timelineWith([NEIGHBOURS])));

    // ~10/s for 40 s of offered load, and none of the 2400-odd other requests.
    expect(with_.systemArrivals).toBeLessThan(500);
    expect(with_.sourceArrivals("neighbours")).toBeGreaterThan(2000);
    expect(with_.systemCompletions + with_.systemDrops).toBeLessThanOrEqual(with_.systemArrivals);
  });

  it("counts its own completions against its own offered rate", () => {
    const with_ = totals(run(timelineWith([NEIGHBOURS])));
    expect(with_.sourceDrops("neighbours")).toBe(0);

    // Not equal to arrivals: the run is cut at 40 s and the handful of requests
    // still in service then have not settled. Anything more than a handful
    // would mean work going missing rather than work still being done.
    const unsettled = with_.sourceArrivals("neighbours") - with_.sourceCompletions("neighbours");
    expect(unsettled).toBeGreaterThanOrEqual(0);
    expect(unsettled).toBeLessThan(10);
  });
});

describe("other traffic that never lands is visible", () => {
  it("records the requests the component turned away", () => {
    // A spine with no room: from the node's side, traffic refused at the door
    // and traffic never stated look the same. The source's own count is the
    // only place the difference shows.
    const tight = timelineWith([{ ...NEIGHBOURS, rate: 400 }], pair({ servers: 1, capacity: 2 }));
    const with_ = totals(run(tight));

    // Nearly all of it is refused: one server at a 20 ms mean cannot take 400/s.
    expect(with_.sourceDrops("neighbours")).toBeGreaterThan(with_.sourceCompletions("neighbours"));

    const unsettled =
      with_.sourceArrivals("neighbours") -
      with_.sourceCompletions("neighbours") -
      with_.sourceDrops("neighbours");
    expect(unsettled).toBeGreaterThanOrEqual(0);
    expect(unsettled).toBeLessThan(10);
  });
});

describe("refusals", () => {
  const check = (sources: readonly TrafficSource[], model = pair()): readonly string[] =>
    validateTimeline(timelineWith(sources, model)).errors;

  it("refuses other traffic on a component that hands work on", () => {
    // The leaf rule: this model knows what "a" does for *this* path. What the
    // other product asks of it is not in the drawing, and guessing would put a
    // confident number on a system nobody submitted.
    expect(check([{ ...NEIGHBOURS, nodeId: "a" }]).join(" ")).toMatch(
      /hands work on to something else.*only land on a component nothing is wired out of/s,
    );
  });

  it("refuses other traffic on a component that is not in the model", () => {
    expect(check([{ ...NEIGHBOURS, nodeId: "ghost" }]).join(" ")).toMatch(
      /"ghost", which is not in the model/,
    );
  });

  it("refuses two sources with the same id", () => {
    expect(check([NEIGHBOURS, NEIGHBOURS]).join(" ")).toMatch(/duplicate traffic source id "neighbours"/);
  });

  it("refuses a negative rate", () => {
    expect(check([{ ...NEIGHBOURS, rate: -1 }]).join(" ")).toMatch(/rate of -1/);
  });

  it("refuses a live rate change aimed at other traffic that does not exist", () => {
    const timeline = timelineWith([NEIGHBOURS]);
    const errors = validateTimeline({
      ...timeline,
      mutations: [{ at: 1, kind: "set-source-rate", sourceId: "ghost", rate: 5 }],
    }).errors;
    expect(errors.join(" ")).toMatch(/other traffic "ghost", which is not in the model/);
  });
});
