import { describe, expect, it } from "vitest";
import { createSimulation, type Job } from "../engine/kernel.ts";
import type { BucketSample } from "../engine/metrics.ts";
import type { MutationEvent, NodeSnapshot, Timeline } from "../engine/timeline.ts";
import { resolveSpec, validateSpec, type PartialComponentSpec, type RetrySpec } from "./format.ts";
import { BEHAVIORS, createModelSimulation } from "./registry.ts";
import { admitJob } from "./server-core.ts";

/**
 * Component semantics (R1, R2, R6).
 *
 * Every policy value has to *do* something observable — a spec format whose enum
 * values are indistinguishable at runtime is decoration. So each discipline,
 * each retry shape and each balancer strategy is pinned to a consequence here,
 * and the death-spiral test asserts that R6's headline dynamic falls out of
 * ordinary parameters rather than being staged anywhere in the code.
 */

function node(id: string, kind: string, spec: PartialComponentSpec): NodeSnapshot {
  return { id, kind, spec: spec as Record<string, unknown> };
}

function run(options: {
  nodes: NodeSnapshot[];
  edges?: Array<{ from: string; to: string }>;
  load: Array<{ rate: number; duration: number }>;
  until: number;
  mutations?: MutationEvent[];
  seed?: string;
  bucketWidth?: number;
}): readonly BucketSample[] {
  const timeline: Timeline = {
    model: {
      entryId: options.nodes[0]?.id ?? null,
      nodes: options.nodes,
      edges: options.edges ?? [],
    },
    load: options.load,
    seed: options.seed ?? "semantics",
    mutations: options.mutations ?? [],
    bucketWidth: options.bucketWidth ?? 1,
  };
  const sim = createModelSimulation(timeline);
  sim.runUntil(options.until);
  return sim.series();
}

type SystemKey = keyof BucketSample["system"];
type NodeKey = keyof NonNullable<BucketSample["nodes"][string]>;

const sumSystem = (series: readonly BucketSample[], key: SystemKey): number =>
  series.reduce((total, bucket) => total + bucket.system[key], 0);

const sumNode = (series: readonly BucketSample[], id: string, key: NodeKey): number =>
  series.reduce((total, bucket) => total + (bucket.nodes[id]?.[key] ?? 0), 0);

const meanNode = (series: readonly BucketSample[], id: string, key: NodeKey): number =>
  series.length === 0 ? 0 : sumNode(series, id, key) / series.length;

/** Buckets whose end lies in `(from, to]` — the window a claim is made about. */
const between = (series: readonly BucketSample[], from: number, to: number): readonly BucketSample[] =>
  series.filter((bucket) => bucket.end > from && bucket.end <= to);

// ------------------------------------------------------------ queue discipline

describe("queue discipline decides who waits and who is shed", () => {
  const job = (id: number, attempt: number): Job =>
    ({ id, createdAt: 0, attempt, settled: false }) as Job;

  const specWith = (policy: "fifo" | "priority" | "drop-oldest", capacity: number) =>
    resolveSpec("service", { queue: { policy, capacity } });

  it("fifo refuses the newcomer once the buffer is full", () => {
    const waiting = [job(1, 0), job(2, 0)];
    const arriving = job(3, 0);

    const rejected = admitJob(waiting, arriving, specWith("fifo", 2));

    expect(rejected).toBe(arriving);
    expect(waiting.map((j) => j.id)).toEqual([1, 2]);
  });

  it("drop-oldest evicts the longest-waiting job to make room", () => {
    const waiting = [job(1, 0), job(2, 0)];
    const arriving = job(3, 0);

    const rejected = admitJob(waiting, arriving, specWith("drop-oldest", 2));

    expect(rejected?.id).toBe(1);
    expect(waiting.map((j) => j.id)).toEqual([2, 3]);
  });

  it("priority puts a first try ahead of retries and sheds the most-retried", () => {
    const waiting = [job(1, 0), job(2, 2), job(3, 2)];
    const arriving = job(4, 0);

    const rejected = admitJob(waiting, arriving, specWith("priority", 3));

    // The fresh request slots in behind the other fresh one, ahead of the retries.
    expect(waiting.map((j) => j.id)).toEqual([1, 4, 2]);
    expect(rejected?.id).toBe(3);
  });

  it("priority is stable within an attempt level, so equal jobs keep arrival order", () => {
    const waiting = [job(1, 0), job(2, 0)];
    const arriving = job(3, 0);

    expect(admitJob(waiting, arriving, specWith("priority", 10))).toBeNull();
    expect(waiting.map((j) => j.id)).toEqual([1, 2, 3]);
  });

  it("serves fresher work under drop-oldest than under fifo, at the same load", () => {
    // The observable consequence of the discipline: fifo serves the oldest thing
    // in the buffer, so what completes has already waited the longest.
    const overloaded = (policy: "fifo" | "drop-oldest"): readonly BucketSample[] =>
      run({
        nodes: [
          node("only", "service", {
            concurrency: 1,
            service: { policy: "fixed", mean: 0.05 },
            queue: { policy, capacity: 20 },
            timeout: { policy: "none", after: 1 },
            retry: { policy: "none", attempts: 0, delay: 0, factor: 2, maxDelay: 1 },
          }),
        ],
        load: [{ rate: 40, duration: 20 }],
        until: 22,
      });

    const fifo = overloaded("fifo");
    const dropOldest = overloaded("drop-oldest");

    expect(sumSystem(fifo, "drops")).toBeGreaterThan(100);
    expect(sumSystem(dropOldest, "drops")).toBeGreaterThan(100);

    const settled = (series: readonly BucketSample[]): readonly BucketSample[] => between(series, 5, 20);
    const fifoLatency = meanNode(settled(fifo), "only", "sojournMean");
    const dropOldestLatency = meanNode(settled(dropOldest), "only", "sojournMean");

    expect(dropOldestLatency).toBeLessThan(fifoLatency);
  });
});

// ---------------------------------------------------------------- concurrency

describe("concurrency", () => {
  it("waits far less with four servers than one, at the same utilization", () => {
    const latencyFor = (concurrency: number, rate: number): number => {
      const series = run({
        nodes: [
          node("s", "service", {
            concurrency,
            service: { policy: "exponential", mean: 0.04 },
            queue: { policy: "fifo", capacity: 100_000 },
            timeout: { policy: "none", after: 1 },
            retry: { policy: "none", attempts: 0, delay: 0, factor: 2, maxDelay: 1 },
          }),
        ],
        load: [{ rate, duration: 2000 }],
        until: 2000,
        bucketWidth: 200,
      });
      const settled = series.slice(1);
      return sumSystem(settled, "latencyMean") / settled.length;
    };

    // Both at rho = 0.8: one server at 20/s, four at 80/s.
    const single = latencyFor(1, 20);
    const four = latencyFor(4, 80);

    expect(single).toBeGreaterThan(0.15); // M/M/1: 1/(25-20) = 0.2
    expect(four).toBeLessThan(single / 2); // M/M/4 waits much less at the same rho
  });

  it("turns into a loss system when nothing is allowed to wait", () => {
    const series = run({
      nodes: [
        node("s", "service", {
          concurrency: 1,
          service: { policy: "fixed", mean: 0.05 },
          queue: { policy: "fifo", capacity: 0 },
          timeout: { policy: "none", after: 1 },
          retry: { policy: "none", attempts: 0, delay: 0, factor: 2, maxDelay: 1 },
        }),
      ],
      load: [{ rate: 30, duration: 10 }],
      until: 12,
    });

    expect(sumNode(series, "s", "queueDepthMean")).toBe(0);
    expect(sumSystem(series, "drops")).toBeGreaterThan(50);
    expect(sumSystem(series, "completions")).toBeGreaterThan(50);
  });
});

// ------------------------------------------------------------ downstream policy

describe("downstream policy decides whether slowness travels back upstream", () => {
  const twoTier = (policy: "call-and-wait" | "fire-and-forget"): readonly BucketSample[] =>
    run({
      nodes: [
        node("api", "service", {
          concurrency: 400,
          service: { policy: "fixed", mean: 0.002 },
          queue: { policy: "fifo", capacity: 10_000 },
          timeout: { policy: "none", after: 10 },
          retry: { policy: "none", attempts: 0, delay: 0, factor: 2, maxDelay: 1 },
          downstream: { policy },
        }),
        node("db", "datastore", {
          concurrency: 1,
          service: { policy: "exponential", mean: 0.02 },
          queue: { policy: "fifo", capacity: 10_000 },
        }),
      ],
      edges: [{ from: "api", to: "db" }],
      load: [{ rate: 45, duration: 20 }],
      until: 22,
    });

  it("holds the caller's capacity while the callee is slow under call-and-wait", () => {
    const waiting = twoTier("call-and-wait");
    const forgetting = twoTier("fire-and-forget");

    const held = meanNode(between(waiting, 5, 20), "api", "residentMean");
    const notHeld = meanNode(between(forgetting, 5, 20), "api", "residentMean");

    // The whole point: a service in front of a loaded datastore reads as loaded.
    expect(held).toBeGreaterThan(notHeld * 10);
    expect(notHeld).toBeLessThan(1);
  });

  it("reports the same end-to-end work either way — only where it is held differs", () => {
    const waiting = twoTier("call-and-wait");
    const forgetting = twoTier("fire-and-forget");

    expect(sumNode(waiting, "db", "arrivals")).toBeGreaterThan(800);
    expect(sumNode(forgetting, "db", "arrivals")).toBeGreaterThan(800);
  });
});

// ------------------------------------------------------- retry amplification

/** The api tier of the death-spiral model, parameterised by its retry policy. */
const apiSpec = (retry: RetrySpec): PartialComponentSpec => ({
  concurrency: 400,
  service: { policy: "fixed", mean: 0.002 },
  queue: { policy: "fifo", capacity: 5_000 },
  timeout: { policy: "fixed", after: 0.25 },
  retry,
});

const SPIRAL_DB = {
  concurrency: 1,
  service: { policy: "exponential" as const, mean: 0.02 },
  queue: { policy: "fifo" as const, capacity: 30 },
};

describe("retry amplification is emergent (R6, AE1 engine half)", () => {
  it("spirals from innocent parameters and recovers on one live preset change", () => {
    // Nothing here is a death spiral on purpose. A datastore that manages 50/s, a
    // load step to 44/s, and a 250 ms timeout. At 44/s the mean wait is already
    // 167 ms, so a fifth of requests miss the timeout, each retries up to three
    // times, and the retries push the offered rate past what the datastore can
    // do — which lengthens the queue, which times out more requests. The engine
    // has no idea any of this is happening.
    const series = run({
      nodes: [
        node("api", "service", apiSpec({ policy: "exponential", attempts: 3, delay: 0.05, factor: 2, maxDelay: 5 })),
        node("db", "datastore", SPIRAL_DB),
      ],
      edges: [{ from: "api", to: "db" }],
      load: [
        { rate: 30, duration: 8 },
        { rate: 44, duration: 40 },
      ],
      until: 48,
      seed: "ae1",
      mutations: [
        {
          at: 24,
          kind: "set-spec",
          nodeId: "api",
          spec: apiSpec({ policy: "capped", attempts: 0, delay: 0.2, factor: 2, maxDelay: 0.5 }) as Record<
            string,
            unknown
          >,
        },
      ],
    });

    const calm = between(series, 0, 8);
    const spiral = between(series, 11, 24);
    const recovered = between(series, 27, 48);

    // Boring and green: almost everything offered completes, nothing retries.
    expect(sumSystem(calm, "completions") / sumSystem(calm, "arrivals")).toBeGreaterThan(0.9);
    expect(sumNode(calm, "api", "retries")).toBe(0);

    // The spiral: downstream sees several times the offered load, and goodput —
    // requests that actually completed for somebody — is gone.
    const amplification = sumNode(spiral, "db", "arrivals") / sumSystem(spiral, "arrivals");
    expect(amplification).toBeGreaterThan(3);
    expect(sumNode(spiral, "api", "retries")).toBeGreaterThan(1_000);
    expect(sumSystem(spiral, "completions")).toBe(0);
    expect(sumNode(spiral, "db", "queueDepthMean") / spiral.length).toBeGreaterThan(25);

    // One mutation, and the amplification is gone and goodput comes back.
    expect(sumNode(recovered, "api", "retries")).toBe(0);
    expect(sumNode(recovered, "db", "arrivals") / sumSystem(recovered, "arrivals")).toBeLessThan(1.05);
    expect(sumSystem(recovered, "completions") / sumSystem(recovered, "arrivals")).toBeGreaterThan(0.8);
  });

  it("replays the spiral-and-recovery run exactly, mutation included (AE3)", () => {
    const once = (): string =>
      JSON.stringify(
        run({
          nodes: [
            node("api", "service", apiSpec({ policy: "exponential", attempts: 3, delay: 0.05, factor: 2, maxDelay: 5 })),
            node("db", "datastore", SPIRAL_DB),
          ],
          edges: [{ from: "api", to: "db" }],
          load: [
            { rate: 30, duration: 8 },
            { rate: 44, duration: 40 },
          ],
          until: 48,
          seed: "ae1",
          mutations: [
            {
              at: 24,
              kind: "set-spec",
              nodeId: "api",
              spec: apiSpec({ policy: "capped", attempts: 0, delay: 0.2, factor: 2, maxDelay: 0.5 }) as Record<
                string,
                unknown
              >,
            },
          ],
        }),
      );

    expect(once()).toBe(once());
  });

  it("makes each retry policy visibly different, not just differently named", () => {
    const amplificationUnder = (retry: RetrySpec): { extra: number; heldThreads: number } => {
      const series = run({
        nodes: [
          node("api", "service", apiSpec(retry)),
          node("db", "datastore", SPIRAL_DB),
        ],
        edges: [{ from: "api", to: "db" }],
        load: [{ rate: 44, duration: 20 }],
        until: 22,
        seed: "shapes",
      });
      const settled = between(series, 4, 20);
      return {
        extra: sumNode(settled, "db", "arrivals") / sumSystem(settled, "arrivals"),
        heldThreads: meanNode(settled, "api", "residentMean"),
      };
    };

    const none = amplificationUnder({ policy: "none", attempts: 3, delay: 0.1, factor: 4, maxDelay: 0.15 });
    const fixed = amplificationUnder({ policy: "fixed", attempts: 2, delay: 0.1, factor: 4, maxDelay: 0.15 });
    const exponential = amplificationUnder({ policy: "exponential", attempts: 2, delay: 0.1, factor: 4, maxDelay: 0.15 });
    const capped = amplificationUnder({ policy: "capped", attempts: 2, delay: 0.1, factor: 4, maxDelay: 0.15 });

    // `none` means the datastore sees exactly the offered load and nothing more.
    expect(none.extra).toBeLessThan(1.05);
    for (const shape of [fixed, exponential, capped]) {
      expect(shape.extra).toBeGreaterThan(1.5);
    }

    // Uncapped backoff waits longer between attempts, and a thread waiting to
    // retry is a thread that is still occupied — so the same attempt budget ties
    // up more of the caller.
    expect(exponential.heldThreads).toBeGreaterThan(capped.heldThreads);
  });
});

// ---------------------------------------------------------------------- cache

describe("cache hit ratio governs what reaches the origin", () => {
  const originTrafficFor = (hitRatio: number): number => {
    const series = run({
      nodes: [
        node("cache", "cache", {
          concurrency: 200,
          service: { policy: "fixed", mean: 0.001 },
          queue: { policy: "fifo", capacity: 10_000 },
          cache: { policy: "fixed-ratio", hitRatio },
        }),
        node("origin", "datastore", {
          concurrency: 50,
          service: { policy: "fixed", mean: 0.005 },
          queue: { policy: "fifo", capacity: 10_000 },
        }),
      ],
      edges: [{ from: "cache", to: "origin" }],
      load: [{ rate: 200, duration: 30 }],
      until: 32,
      seed: "cache",
    });
    return sumNode(series, "origin", "arrivals") / sumSystem(series, "arrivals");
  };

  it("passes through roughly the miss rate and no more", () => {
    expect(originTrafficFor(0.9)).toBeGreaterThan(0.08);
    expect(originTrafficFor(0.9)).toBeLessThan(0.12);
    expect(originTrafficFor(0.3)).toBeGreaterThan(0.66);
    expect(originTrafficFor(0.3)).toBeLessThan(0.74);
  });

  it("sends everything to the origin at a zero hit ratio and nothing at one", () => {
    expect(originTrafficFor(0)).toBeGreaterThan(0.99);
    expect(originTrafficFor(1)).toBe(0);
  });

  it("drops a miss when there is no origin behind it, rather than reporting a hit", () => {
    const series = run({
      nodes: [
        node("cache", "cache", {
          concurrency: 50,
          service: { policy: "fixed", mean: 0.001 },
          queue: { policy: "fifo", capacity: 1_000 },
          cache: { policy: "fixed-ratio", hitRatio: 0.5 },
        }),
      ],
      load: [{ rate: 100, duration: 10 }],
      until: 12,
      seed: "orphan-cache",
    });

    const drops = sumSystem(series, "drops");
    const completions = sumSystem(series, "completions");
    expect(drops).toBeGreaterThan(0.4 * (drops + completions));
    expect(completions).toBeGreaterThan(0.4 * (drops + completions));
  });
});

// ------------------------------------------------------------------- balancer

describe("balancer strategy", () => {
  const threeWay = (policy: "round-robin" | "random" | "least-queue", slowTail = false): number[] => {
    const replica = (id: string, mean: number): NodeSnapshot =>
      node(id, "service", {
        concurrency: 1,
        service: { policy: "fixed", mean },
        queue: { policy: "fifo", capacity: 10_000 },
        timeout: { policy: "none", after: 1 },
        retry: { policy: "none", attempts: 0, delay: 0, factor: 2, maxDelay: 1 },
      });

    const series = run({
      nodes: [
        node("lb", "balancer", { balancer: { policy } }),
        replica("r1", 0.01),
        replica("r2", 0.01),
        replica("r3", slowTail ? 0.2 : 0.01),
      ],
      edges: [
        { from: "lb", to: "r1" },
        { from: "lb", to: "r2" },
        { from: "lb", to: "r3" },
      ],
      load: [{ rate: 30, duration: 20 }],
      until: 22,
      seed: "balance",
    });

    return ["r1", "r2", "r3"].map((id) => sumNode(series, id, "arrivals"));
  };

  it("splits evenly and exactly under round-robin", () => {
    const counts = threeWay("round-robin");
    expect(Math.max(...counts) - Math.min(...counts)).toBeLessThanOrEqual(1);
    expect(counts.reduce((a, b) => a + b, 0)).toBeGreaterThan(500);
  });

  it("spreads unevenly under random, since each choice is independent", () => {
    const counts = threeWay("random");
    const total = counts.reduce((a, b) => a + b, 0);
    for (const count of counts) {
      expect(count).toBeGreaterThan(0.2 * total);
    }
    // Seed-pinned: an exactly even split would mean it was not choosing at all.
    expect(Math.max(...counts) - Math.min(...counts)).toBeGreaterThan(1);
  });

  it("steers away from a struggling replica under least-queue", () => {
    const [fastA, fastB, slow] = threeWay("least-queue", true) as [number, number, number];
    expect(slow).toBeLessThan(fastA);
    expect(slow).toBeLessThan(fastB);
  });

  it("refuses a request rather than crashing if it is reached with nothing behind it", () => {
    // The wiring check stops this model being built at all (see the wiring
    // tests). This is the second line of defence, on the raw kernel path: the
    // balancer sheds with a reason instead of throwing mid-run.
    const sim = createSimulation(
      {
        model: {
          entryId: "lb",
          nodes: [node("lb", "balancer", { balancer: { policy: "round-robin" } })],
          edges: [],
        },
        load: [{ rate: 10, duration: 5 }],
        seed: "semantics",
        mutations: [],
        bucketWidth: 1,
      },
      BEHAVIORS,
    );
    sim.runUntil(6);
    const series = sim.series();

    expect(sumSystem(series, "drops")).toBeGreaterThan(30);
    expect(sumSystem(series, "completions")).toBe(0);
  });
});

// -------------------------------------------------------------- invalid specs

describe("a spec that cannot mean anything is refused", () => {
  const build = (kind: string, spec: Record<string, unknown>): (() => unknown) => () =>
    createSimulation(
      {
        model: { entryId: "x", nodes: [{ id: "x", kind, spec }], edges: [] },
        load: [{ rate: 1, duration: 1 }],
        seed: "invalid",
        mutations: [],
      },
      BEHAVIORS,
    );

  it("rejects a policy value outside its enum, listing what is allowed", () => {
    expect(build("service", { queue: { policy: "lifo", capacity: 10 } })).toThrow(/lifo/);
    expect(build("service", { queue: { policy: "lifo", capacity: 10 } })).toThrow(/fifo, priority, drop-oldest/);
  });

  it("rejects an unrunnable policy but tolerates a concern the kind simply ignores", () => {
    // A node's spec is often a preset's resolved form, which carries every
    // concern including the ones this kind never reads. That has to run. Setting
    // `retry` on a datastore *by hand* is still a mistake, and the authoring
    // check catches it — see registry.test.ts.
    const withUnusedConcern = { retry: { policy: "fixed", attempts: 1, delay: 0.1, factor: 2, maxDelay: 1 } };
    expect(build("datastore", withUnusedConcern)).not.toThrow();
    expect(validateSpec("datastore", withUnusedConcern).errors.join("\n")).toMatch(
      /datastore does not use "retry"/,
    );
    // But an unusable value in a concern the kind *does* read still stops the run.
    expect(build("datastore", { service: { policy: "erlang", mean: 0.01 } })).toThrow(/erlang/);
  });

  it("rejects out-of-range parameters, naming the field", () => {
    expect(build("service", { concurrency: 0 })).toThrow(/concurrency/);
    expect(build("cache", { cache: { policy: "fixed-ratio", hitRatio: 1.4 } })).toThrow(/hitRatio/);
    expect(build("service", { queue: { policy: "fifo", capacity: -1 } })).toThrow(/capacity/);
  });

  it("names the node as well as the problem", () => {
    expect(build("service", { concurrency: -3 })).toThrow(/node "x"/);
  });

  it("refuses a mid-run mutation that would leave a node unrunnable", () => {
    const sim = createSimulation(
      {
        model: {
          entryId: "s",
          nodes: [node("s", "service", { concurrency: 2, service: { policy: "fixed", mean: 0.01 } })],
          edges: [],
        },
        load: [{ rate: 10, duration: 10 }],
        seed: "bad-mutation",
        mutations: [{ at: 2, kind: "set-spec", nodeId: "s", spec: { service: { policy: "erlang", mean: 0.01 } } }],
      },
      BEHAVIORS,
    );

    expect(() => sim.runUntil(5)).toThrow(/erlang/);
  });
});

// ---------------------------------------------------------------------- wiring

describe("wiring rules that follow from what components can do", () => {
  const twoEdgesFrom = (kind: string) => ({
    entryId: "front",
    nodes: [
      node("front", kind, kind === "balancer" ? { balancer: { policy: "round-robin" as const } } : { concurrency: 2 }),
      node("a", "datastore", { concurrency: 4 }),
      node("b", "datastore", { concurrency: 4 }),
    ],
    edges: [
      { from: "front", to: "a" },
      { from: "front", to: "b" },
    ],
  });

  it("refuses a service drawn with two downstream edges, and says to use a balancer", () => {
    // Left unchecked this would silently use the first edge, so the canvas would
    // show a fan-out the numbers know nothing about.
    expect(() =>
      createModelSimulation({
        model: twoEdgesFrom("service"),
        load: [{ rate: 5, duration: 2 }],
        seed: "fan-out",
        mutations: [],
      }),
    ).toThrow(/hands work on to 2 places/i);

    expect(() =>
      createModelSimulation({
        model: twoEdgesFrom("service"),
        load: [{ rate: 5, duration: 2 }],
        seed: "fan-out",
        mutations: [],
      }),
    ).toThrow(/load balancer/);
  });

  it("allows as many dependencies as a component really has", () => {
    // The same two edges, marked as things the service calls and waits for. This
    // is not a fan-out: work still goes on to one place, and a Redis leaned on by
    // five components is the shape the rule used to forbid drawing at all.
    const model = twoEdgesFrom("service");
    expect(() =>
      createModelSimulation({
        model: {
          ...model,
          edges: model.edges.map((edge) => ({ ...edge, kind: "call" as const })),
        },
        load: [{ rate: 5, duration: 2 }],
        seed: "dependencies",
        mutations: [],
      }),
    ).not.toThrow();
  });

  it("refuses a dependency on a balancer, which has no slot to hold", () => {
    const model = twoEdgesFrom("balancer");
    expect(() =>
      createModelSimulation({
        model: {
          ...model,
          edges: [model.edges[0] as never, { from: "front", to: "b", kind: "call" as const }],
        },
        load: [{ rate: 5, duration: 2 }],
        seed: "dependencies",
        mutations: [],
      }),
    ).toThrow(/routes rather than works/);
  });

  it("allows a balancer to fan out, since that is the whole component", () => {
    expect(() =>
      createModelSimulation({
        model: twoEdgesFrom("balancer"),
        load: [{ rate: 5, duration: 2 }],
        seed: "fan-out",
        mutations: [],
      }),
    ).not.toThrow();
  });

  it("refuses a balancer with nothing behind it", () => {
    expect(() =>
      createModelSimulation({
        model: {
          entryId: "lb",
          nodes: [node("lb", "balancer", { balancer: { policy: "round-robin" } })],
          edges: [],
        },
        load: [{ rate: 5, duration: 2 }],
        seed: "empty-lb",
        mutations: [],
      }),
    ).toThrow(/nothing wired behind it/);
  });
});
