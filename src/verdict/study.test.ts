/**
 * Comparisons: what the baseline of a proposal is, and what gets swept.
 *
 * The bulk of this file is `baselineOf`, because it is the one piece here that
 * makes a judgement rather than arranging work. Every other part of a comparison
 * is arithmetic on sweeps that are already tested; the baseline is a graph
 * transformation that has to be right for two structurally different kinds of
 * proposal, and wrong in either direction it produces a confident number about a
 * system nobody drew.
 */
import { describe, expect, it } from "vitest";
import { armsFor, baselineOf, disputedLabel, runStudy, withDisputedValue } from "./study.ts";
import { SWEEP_BUDGET, type SweepBudget } from "./sweep.ts";
import type { ModelSnapshot } from "../engine/timeline.ts";

const FAST: SweepBudget = { ...SWEEP_BUDGET, warmUpSeconds: 5, measureSeconds: 40 };

const service = (mu: number): Record<string, unknown> => ({
  concurrency: 1,
  service: { policy: "exponential", mean: 1 / mu },
  queue: { policy: "fifo", capacity: 500 },
  timeout: { policy: "none", after: 1 },
  retry: { policy: "none", attempts: 0, delay: 0, factor: 2, maxDelay: 1 },
});

const store = (mu: number): Record<string, unknown> => ({
  concurrency: 1,
  service: { policy: "exponential", mean: 1 / mu },
  queue: { policy: "fifo", capacity: 500 },
});

/** balancer → two services → one datastore: the shape most proposals arrive on. */
function fleet(): ModelSnapshot {
  return {
    entryId: "lb",
    nodes: [
      { id: "lb", kind: "balancer", spec: { balancer: { policy: "round-robin" } } },
      { id: "api-1", kind: "service", spec: service(200) },
      { id: "api-2", kind: "service", spec: service(200) },
      { id: "db", kind: "datastore", spec: store(50) },
    ],
    edges: [
      { from: "lb", to: "api-1" },
      { from: "lb", to: "api-2" },
      { from: "api-1", to: "db" },
      { from: "api-2", to: "db" },
    ],
  };
}

const wires = (model: ModelSnapshot): string[] => model.edges.map((edge) => `${edge.from}→${edge.to}`);

describe("deriving the baseline", () => {
  it("restores every wire an inserted component displaced, not just enough to reconnect", () => {
    // A cache inserted between both services and the datastore: the author drew
    // api → cache → db and deleted the two direct wires.
    const withCache: ModelSnapshot = {
      entryId: "lb",
      nodes: [...fleet().nodes, { id: "cache", kind: "cache", spec: { cache: { policy: "fixed-ratio", hitRatio: 0.5 } } }],
      edges: [
        { from: "lb", to: "api-1" },
        { from: "lb", to: "api-2" },
        { from: "api-1", to: "cache" },
        { from: "api-2", to: "cache" },
        { from: "cache", to: "db" },
      ],
    };

    // Both services get their wire back. Restoring only api-1's would reconnect
    // the datastore to the graph and leave api-2 a dead end — a baseline that
    // reconnects the picture and changes the design.
    expect(wires(baselineOf(withCache, ["cache"]))).toEqual(wires(fleet()));
  });

  it("adds no wire when the proposal was added in parallel", () => {
    const withReplica: ModelSnapshot = {
      entryId: "lb",
      nodes: [...fleet().nodes, { id: "api-3", kind: "service", spec: service(200) }],
      edges: [...fleet().edges, { from: "lb", to: "api-3" }, { from: "api-3", to: "db" }],
    };

    // The balancer can still reach the datastore through the other replicas, so
    // bridging would hand it a wire straight there — half the traffic skipping
    // the tier the model exists to describe.
    expect(wires(baselineOf(withReplica, ["api-3"]))).toEqual(wires(fleet()));
  });

  it("removes a chain of proposal components as one", () => {
    const withChain: ModelSnapshot = {
      entryId: "lb",
      nodes: [
        ...fleet().nodes,
        { id: "queue", kind: "queue", spec: { queue: { policy: "fifo", capacity: 100 } } },
        { id: "cache", kind: "cache", spec: { cache: { policy: "fixed-ratio", hitRatio: 0.5 } } },
      ],
      edges: [
        { from: "lb", to: "api-1" },
        { from: "lb", to: "api-2" },
        { from: "api-1", to: "queue" },
        { from: "api-2", to: "queue" },
        { from: "queue", to: "cache" },
        { from: "cache", to: "db" },
      ],
    };

    expect(wires(baselineOf(withChain, ["queue", "cache"]))).toEqual(wires(fleet()));
  });

  it("keeps the other traffic on components the baseline still has", () => {
    // A cache inserted in front of a datastore that other services also use. The
    // datastore's other traffic is there with or without the cache, so a baseline
    // without it would be a quieter system than the one anybody drew.
    const withCache: ModelSnapshot = {
      entryId: "lb",
      nodes: [...fleet().nodes, { id: "cache", kind: "cache", spec: { cache: { policy: "fixed-ratio", hitRatio: 0.5 } } }],
      edges: [
        { from: "lb", to: "api-1" },
        { from: "lb", to: "api-2" },
        { from: "api-1", to: "cache" },
        { from: "api-2", to: "cache" },
        { from: "cache", to: "db" },
      ],
      sources: [{ id: "reports", name: "the reporting jobs", nodeId: "db", rate: 20 }],
    };

    expect(baselineOf(withCache, ["cache"]).sources).toEqual(withCache.sources);
  });

  it("drops the other traffic on a component the proposal adds", () => {
    // A proposed shared session store that other services would use too. Without
    // it there is nothing for that traffic to land on.
    const withStore: ModelSnapshot = {
      ...fleet(),
      nodes: [...fleet().nodes, { id: "sessions", kind: "datastore", spec: store(500) }],
      edges: [...fleet().edges, { from: "api-1", to: "sessions", kind: "call", times: 1 }],
      sources: [
        { id: "reports", name: "the reporting jobs", nodeId: "db", rate: 20 },
        { id: "other-apps", name: "other apps' sessions", nodeId: "sessions", rate: 5 },
      ],
    };

    expect(baselineOf(withStore, ["sessions"]).sources?.map((source) => source.id)).toEqual(["reports"]);
  });

  it("leaves a model alone when nothing is marked", () => {
    expect(baselineOf(fleet(), [])).toEqual(fleet());
  });

  it("ignores marks for components that are not there", () => {
    expect(baselineOf(fleet(), ["ghost"])).toEqual(fleet());
  });

  it("refuses to take out the entry point", () => {
    expect(() => baselineOf(fleet(), ["lb"])).toThrow(/where load enters/);
  });

  it("refuses when removal leaves a component fanning out, and says so as a baseline problem", () => {
    // A proposal whose removal would leave one service wired to two places. That
    // is a real limit of un-inserting, and the message has to say it is the
    // baseline that cannot be formed — the design on screen is fine.
    const forked: ModelSnapshot = {
      entryId: "api-1",
      nodes: [
        { id: "api-1", kind: "service", spec: service(200) },
        { id: "fan", kind: "balancer", spec: { balancer: { policy: "round-robin" } } },
        { id: "db", kind: "datastore", spec: store(50) },
        { id: "db-2", kind: "datastore", spec: store(50) },
      ],
      edges: [
        { from: "api-1", to: "fan" },
        { from: "fan", to: "db" },
        { from: "fan", to: "db-2" },
      ],
    };

    expect(() => baselineOf(forked, ["fan"])).toThrow(/baseline|cannot run/i);
  });
});

describe("setting a disputed parameter", () => {
  it("writes the value through the same code the editor edits with", () => {
    const changed = withDisputedValue(fleet(), { componentId: "db", field: "capacity", min: 40, max: 60 }, 40);
    const db = changed.nodes.find((node) => node.id === "db");

    // 40/s on a one-connection store is 25 ms a query.
    expect((db?.spec as { service: { mean: number } }).service.mean).toBeCloseTo(0.025, 6);
    // And nothing else moved.
    expect(changed.nodes.filter((node) => node.id !== "db")).toEqual(fleet().nodes.filter((node) => node.id !== "db"));
  });

  it("names the parameter the way the readout has to say it", () => {
    expect(disputedLabel(fleet(), { componentId: "db", field: "capacity", min: 40, max: 60 })).toBe("db capacity");
  });

  it("refuses a setting the component does not have", () => {
    expect(() => withDisputedValue(fleet(), { componentId: "db", field: "retries", min: 1, max: 3 }, 1)).toThrow(
      /no setting called/,
    );
  });
});

describe("what gets swept", () => {
  it("sweeps once when there is nothing to compare", () => {
    expect(armsFor(fleet(), { delta: [], disputed: null })).toHaveLength(1);
  });

  it("sweeps twice for a proposal, twice for a disputed range, four times for both", () => {
    const disputed = { componentId: "db", field: "capacity", min: 40, max: 60 };

    expect(armsFor(fleet(), { delta: ["api-2"], disputed: null }).map((arm) => arm.side)).toEqual([
      "proposal",
      "baseline",
    ]);
    expect(armsFor(fleet(), { delta: [], disputed }).map((arm) => arm.end)).toEqual(["low", "high"]);
    expect(armsFor(fleet(), { delta: ["api-2"], disputed })).toHaveLength(4);
  });

  it("labels each arm with what makes it different", () => {
    const arms = armsFor(fleet(), {
      delta: ["api-2"],
      disputed: { componentId: "db", field: "capacity", min: 40, max: 60 },
    });

    expect(arms.map((arm) => arm.label)).toEqual([
      "Proposal · db capacity 40",
      "Proposal · db capacity 60",
      "Baseline · db capacity 40",
      "Baseline · db capacity 60",
    ]);
  });
});

describe("running a comparison", () => {
  it("runs every arm on the same arrival stream", () => {
    const study = runStudy(
      { model: fleet(), seed: "study-test", baseRate: 20 },
      { delta: [], disputed: { componentId: "db", field: "capacity", min: 40, max: 60 } },
      { budget: FAST },
    );

    const seeds = study.arms.flatMap((arm) => arm.result?.probes.map((probe) => probe.seed) ?? []);
    expect(new Set(seeds)).toEqual(new Set(["study-test"]));
  });

  it("finds a higher breaking point at the generous end of a disputed range", () => {
    const study = runStudy(
      { model: fleet(), seed: "study-test", baseRate: 20 },
      { delta: [], disputed: { componentId: "db", field: "capacity", min: 30, max: 60 } },
      { budget: FAST },
    );

    const low = study.arms.find((arm) => arm.end === "low")?.result?.holds ?? 0;
    const high = study.arms.find((arm) => arm.end === "high")?.result?.holds ?? 0;
    expect(high).toBeGreaterThan(low);
  });

  it("keeps the arms that worked when one of them cannot be built", () => {
    // Marking the entry point makes the baseline impossible; the proposal arm is
    // still a real answer and throwing it away would lose the half that worked.
    const study = runStudy(
      { model: fleet(), seed: "study-test", baseRate: 20 },
      { delta: ["lb"], disputed: null },
      { budget: FAST },
    );

    expect(study.arms.find((arm) => arm.side === "proposal")?.result).not.toBeNull();
    const failed = study.arms.find((arm) => arm.side === "baseline");
    expect(failed?.result).toBeNull();
    expect(failed?.error).toMatch(/where load enters/);
  });

  it("reports probes as they land, tagged with the arm they belong to", () => {
    const seen: string[] = [];
    runStudy(
      { model: fleet(), seed: "study-test", baseRate: 20 },
      { delta: ["api-2"], disputed: null },
      { budget: FAST, onProbe: (arm) => seen.push(arm) },
    );

    expect(new Set(seen)).toEqual(new Set(["Proposal", "Baseline"]));
  });
});
