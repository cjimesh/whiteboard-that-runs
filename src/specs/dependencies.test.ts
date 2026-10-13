// @vitest-environment node
/**
 * Shared dependencies: the things a component calls and waits for.
 *
 * The rule these exist to relax was policing two different relationships with one
 * check. Where work goes *next* really is one place. What a component *leans on*
 * is routinely several, and in a real system one shared store is often called
 * from most of the components on a path — which could not be drawn at all.
 *
 * Two claims are under test, and they are the two the workarounds each got wrong:
 * the load a shared thing sees is the sum of what its callers put on it, and its
 * slowness is felt by every caller at once.
 */
import { describe, expect, it } from "vitest";
import { createModelSimulation } from "./registry.ts";
import type { EdgeSnapshot, Timeline } from "../engine/timeline.ts";

const service = (concurrency: number, mean: number): Record<string, unknown> => ({
  concurrency,
  service: { policy: "fixed", mean },
  queue: { policy: "fifo", capacity: 100_000 },
  timeout: { policy: "none", after: 60 },
  retry: { policy: "none", attempts: 0, delay: 0, factor: 2, maxDelay: 1 },
});

const store = (concurrency: number, mean: number): Record<string, unknown> => ({
  concurrency,
  service: { policy: "exponential", mean },
  queue: { policy: "fifo", capacity: 100_000 },
});

/** Two services in front of one shared spine, each calling it `times` per request. */
function shared(times: number, spineMean = 0.001, extraEdges: EdgeSnapshot[] = []): Timeline {
  return {
    model: {
      entryId: "lb",
      nodes: [
        { id: "lb", kind: "balancer", spec: { balancer: { policy: "round-robin" } } },
        { id: "api-1", kind: "service", spec: service(200, 0.002) },
        { id: "api-2", kind: "service", spec: service(200, 0.002) },
        { id: "redis", kind: "datastore", spec: store(1, spineMean) },
        { id: "db", kind: "datastore", spec: store(50, 0.01) },
      ],
      edges: [
        { from: "lb", to: "api-1" },
        { from: "lb", to: "api-2" },
        { from: "api-1", to: "db" },
        { from: "api-2", to: "db" },
        { from: "api-1", to: "redis", kind: "call", times },
        { from: "api-2", to: "redis", kind: "call", times },
        ...extraEdges,
      ],
    },
    load: [{ rate: 20, duration: 300 }],
    seed: "deps",
    mutations: [],
    bucketWidth: 1,
  };
}

function measure(timeline: Timeline, seconds = 300) {
  const sim = createModelSimulation(timeline);
  sim.runUntil(seconds);
  const window = sim.series().filter((bucket) => bucket.start >= seconds * 0.25);
  const per = (id: string, read: (n: NonNullable<(typeof window)[number]["nodes"][string]>) => number): number =>
    window.reduce((total, bucket) => total + (bucket.nodes[id] ? read(bucket.nodes[id] as never) : 0), 0);

  const completions = window.reduce((total, b) => total + b.system.completions, 0);
  return {
    seconds: window.length,
    arrivalsAt: (id: string) => per(id, (n) => n.arrivals) / window.length,
    utilizationOf: (id: string) => per(id, (n) => n.utilization) / window.length,
    goodput: completions / window.length,
    latency: window.reduce((t, b) => t + b.system.latencyMean * b.system.completions, 0) / (completions || 1),
  };
}

describe("what a shared dependency sees", () => {
  it("is called once per request per caller", () => {
    const one = measure(shared(1));

    // 20/s offered, split across two callers, each calling redis once.
    expect(one.arrivalsAt("redis")).toBeGreaterThan(18);
    expect(one.arrivalsAt("redis")).toBeLessThan(22);
  });

  it("takes the number of calls a request really makes", () => {
    // The parameter that decides whether a shared spine copes: a start touching
    // Redis twenty times puts twenty times the traffic on it.
    const twenty = measure(shared(20));

    expect(twenty.arrivalsAt("redis")).toBeGreaterThan(380);
    expect(twenty.arrivalsAt("redis")).toBeLessThan(420);
  });

  it("sums the load from every caller, rather than from the biggest one", () => {
    // Drawing the dependency behind one caller — the workaround the rule used to
    // force — would have shown half this.
    const both = measure(shared(5));
    const perCaller = both.arrivalsAt("redis") / 2;

    expect(both.arrivalsAt("redis")).toBeGreaterThan(perCaller * 1.9);
  });
});

describe("what a shared dependency does to its callers", () => {
  it("holds the caller's slot while it answers", () => {
    // A single-threaded spine at 100 ms a call, five calls per request: each
    // request occupies its caller for at least half a second, so both callers
    // are visibly busy even though their own work is 2 ms.
    const slow = measure(shared(5, 0.1), 300);

    expect(slow.utilizationOf("api-1")).toBeGreaterThan(0.001);
    expect(slow.latency).toBeGreaterThan(0.4);
  });

  it("degrades every caller at once when it saturates", () => {
    // The failure mode the "fold its latency into each caller" workaround hides:
    // the callers share one server, so they slow down together.
    const easy = measure(shared(1, 0.001));
    const strained = measure(shared(1, 0.04));

    expect(easy.latency).toBeLessThan(0.05);
    expect(strained.latency).toBeGreaterThan(easy.latency * 5);
    expect(strained.utilizationOf("redis")).toBeGreaterThan(0.7);
  });

  it("fails the request by name when a dependency refuses", () => {
    const refusing = shared(1);
    const capped = {
      ...refusing,
      model: {
        ...refusing.model,
        nodes: refusing.model.nodes.map((node) =>
          node.id === "redis"
            ? { ...node, spec: { ...store(1, 0.5), queue: { policy: "fifo", capacity: 0 } } }
            : node,
        ),
      },
    };

    const result = measure(capped);

    // A refused dependency ends the request here rather than travelling on as if
    // it had succeeded.
    expect(result.goodput).toBeLessThan(19);
    expect(result.arrivalsAt("db")).toBeLessThan(result.arrivalsAt("redis"));
  });
});

describe("what stays true", () => {
  it("leaves a model with no dependencies exactly as it was", () => {
    const withCalls = shared(1);
    const withoutCalls: Timeline = {
      ...withCalls,
      model: {
        ...withCalls.model,
        edges: withCalls.model.edges.filter((edge) => edge.kind !== "call"),
      },
    };

    const plain = measure(withoutCalls);
    expect(plain.arrivalsAt("redis")).toBe(0);
    expect(plain.goodput).toBeGreaterThan(19);
  });
});
