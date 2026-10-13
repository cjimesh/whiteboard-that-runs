import { describe, expect, it } from "vitest";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { createSimulation, type BehaviorRegistry, type CallOutcome } from "./kernel.ts";
import { referenceRegistry, type Trace } from "./reference-nodes.ts";
import type { ModelSnapshot, Timeline } from "./timeline.ts";

/**
 * The determinism contract (R5, AE3).
 *
 * This file was written before the kernel it tests. The whole product rests on
 * one claim — "run it again and you get the same answer, even the run where I
 * dragged the slider mid-demo" — and a kernel written first and tested second
 * tends to end up deterministic-in-practice rather than deterministic-by-design.
 */

function chain(ids: string[]): ModelSnapshot {
  return {
    entryId: ids[0] ?? null,
    nodes: ids.map((id) => ({
      id,
      kind: "reference",
      spec: { service: { kind: "exponential", rate: 12 }, servers: 1 },
    })),
    edges: ids.slice(0, -1).map((from, i) => ({ from, to: ids[i + 1] as string })),
  };
}

function baseTimeline(overrides: Partial<Timeline> = {}): Timeline {
  return {
    model: chain(["a", "b"]),
    load: [
      { rate: 8, duration: 6 },
      { rate: 20, duration: 4 },
      { rate: 8, duration: 6 },
    ],
    seed: "determinism",
    mutations: [],
    bucketWidth: 1,
    ...overrides,
  };
}

function runHeadless(timeline: Timeline, until = 16): string {
  const sim = createSimulation(timeline, referenceRegistry());
  sim.runUntil(until);
  return JSON.stringify(sim.series());
}

describe("replay equality (AE3)", () => {
  it("produces an identical metrics series when the same timeline is run twice", () => {
    const timeline = baseTimeline();
    expect(runHeadless(timeline)).toBe(runHeadless(timeline));
  });

  it("replays a run that included mid-run mutations, exactly", () => {
    // The demo case: someone dragged a parameter while the room watched. The
    // recorded timeline has to reproduce that run and not merely a similar one.
    const timeline = baseTimeline({
      mutations: [
        { at: 3, kind: "set-spec", nodeId: "b", spec: { service: { kind: "exponential", rate: 6 } } },
        { at: 7, kind: "set-load", segments: [{ rate: 30, duration: 5 }] },
        { at: 9, kind: "set-spec", nodeId: "b", spec: { service: { kind: "exponential", rate: 25 } } },
      ],
    });

    expect(runHeadless(timeline)).toBe(runHeadless(timeline));
  });

  it("distinguishes runs that differ only in a mutation, so equality is not vacuous", () => {
    const withMutation = baseTimeline({
      mutations: [
        { at: 3, kind: "set-spec", nodeId: "b", spec: { service: { kind: "exponential", rate: 3 } } },
      ],
    });

    expect(runHeadless(baseTimeline())).not.toBe(runHeadless(withMutation));
  });

  it("holds across three structurally distinct timelines", () => {
    const timelines: Timeline[] = [
      baseTimeline({ model: chain(["only"]), load: [{ rate: 5, duration: 10 }] }),
      baseTimeline({ model: chain(["a", "b", "c", "d"]), seed: "four-deep" }),
      baseTimeline({
        model: {
          entryId: "in",
          nodes: [
            {
              id: "in",
              kind: "reference",
              spec: {
                service: { kind: "fixed", time: 0.02 },
                servers: 4,
                timeoutAfter: 0.4,
                maxAttempts: 3,
              },
            },
            {
              id: "deep",
              kind: "reference",
              spec: { service: { kind: "exponential", rate: 9 }, servers: 1, capacity: 40 },
            },
          ],
          edges: [{ from: "in", to: "deep" }],
        },
        seed: "retrying",
      }),
    ];

    for (const timeline of timelines) {
      expect(runHeadless(timeline)).toBe(runHeadless(timeline));
    }
  });
});

describe("live recording replays exactly (R7 into AE3)", () => {
  it("reproduces a session that was driven by hand, frame by frame", () => {
    // The claim this makes true: a run where somebody dragged a slider in front
    // of a room can be replayed afterwards and land on the same numbers. The
    // live path stamps each change with the sim clock and appends it to the same
    // log a replay reads, so there is no second code path to keep honest.
    const live = createSimulation(baseTimeline(), referenceRegistry());
    const deltas = [0.016, 0.033, 0.008, 0.25, 0.017];
    let i = 0;

    while (live.now() < 14) {
      live.advance(deltas[i % deltas.length] as number);
      i += 1;
      // Two operator actions, at whatever sim time the frames happened to reach.
      if (i === 40) {
        live.record({ kind: "set-spec", nodeId: "b", spec: { service: { kind: "exponential", rate: 5 } } });
      }
      if (i === 200) {
        live.record({ kind: "set-load", segments: [{ rate: 35, duration: 20 }] });
      }
    }
    const endedAt = live.now();

    const recorded = live.recorded();
    expect(recorded.mutations).toHaveLength(2);
    expect(recorded.mutations[0]?.at).toBeGreaterThan(0);

    const replay = createSimulation(recorded, referenceRegistry());
    replay.runUntil(endedAt);

    expect(JSON.stringify(replay.series())).toBe(JSON.stringify(live.series()));
  });

  it("makes the recorded log the difference, not incidental", () => {
    const live = createSimulation(baseTimeline(), referenceRegistry());
    live.runUntil(5);
    live.record({ kind: "set-spec", nodeId: "b", spec: { service: { kind: "exponential", rate: 2 } } });
    live.runUntil(14);

    const untouched = createSimulation(baseTimeline(), referenceRegistry());
    untouched.runUntil(14);

    expect(JSON.stringify(live.series())).not.toBe(JSON.stringify(untouched.series()));
  });

  it("refuses a live change it cannot apply, naming the offender", () => {
    const live = createSimulation(baseTimeline(), referenceRegistry());
    live.runUntil(3);

    expect(() => live.record({ kind: "set-spec", nodeId: "ghost", spec: {} })).toThrow(/ghost/);
    // And the refusal leaves the log clean, so the session stays replayable.
    expect(live.recorded().mutations).toHaveLength(0);
  });

  it("keeps the log in sim-time order across many changes", () => {
    const live = createSimulation(baseTimeline(), referenceRegistry());
    for (let step = 1; step <= 20; step += 1) {
      live.advance(0.5);
      live.record({ kind: "set-load", segments: [{ rate: 10 + step, duration: 30 }] });
    }

    const stamps = live.recorded().mutations.map((mutation) => mutation.at);
    expect(stamps).toHaveLength(20);
    for (let i = 1; i < stamps.length; i += 1) {
      expect(stamps[i] as number).toBeGreaterThanOrEqual(stamps[i - 1] as number);
    }

    const replay = createSimulation(live.recorded(), referenceRegistry());
    replay.runUntil(live.now());
    expect(JSON.stringify(replay.series())).toBe(JSON.stringify(live.series()));
  });
});

describe("one engine, two drivers", () => {
  it("gives the paced driver and the headless driver identical results", () => {
    // The paced driver is fed jittery deltas on purpose: real animation frames
    // are never evenly spaced, and if frame pacing can leak into the numbers
    // then a recording made during a live demo is not replayable.
    const timeline = baseTimeline({
      mutations: [
        { at: 4.5, kind: "set-spec", nodeId: "a", spec: { service: { kind: "exponential", rate: 30 } } },
      ],
    });

    const paced = createSimulation(timeline, referenceRegistry());
    const deltas = [0.016, 0.033, 0.008, 0.25, 0.017, 0.017, 0.9, 0.004];
    let i = 0;
    while (paced.now() < 16) {
      paced.advance(deltas[i % deltas.length] as number);
      i += 1;
    }

    // The paced driver lands wherever its last frame put it; the headless run
    // is drained to that same sim time in one go. Same instant, one thousand
    // frames apart in how they got there.
    const headless = createSimulation(timeline, referenceRegistry());
    headless.runUntil(paced.now());

    expect(i).toBeGreaterThan(100);
    expect(JSON.stringify(paced.series())).toBe(JSON.stringify(headless.series()));
  });

  it("never runs the clock backwards, whatever the driver asks for", () => {
    const sim = createSimulation(baseTimeline(), referenceRegistry());
    sim.runUntil(5);
    expect(() => sim.runUntil(4)).toThrow(/backwards/i);
    expect(sim.now()).toBe(5);
  });
});

describe("simultaneous events (stable tie-break)", () => {
  it("settles work in flight before applying a mutation stamped at the same instant", () => {
    // Deterministic arrivals at t = 1, 2, 3... and a fixed 0.5s service put a
    // service-end at exactly t = 1.5. The mutation is stamped at exactly 1.5.
    const trace: Trace = [];
    const timeline: Timeline = {
      model: {
        entryId: "s",
        nodes: [{ id: "s", kind: "reference", spec: { service: { kind: "fixed", time: 0.5 } } }],
        edges: [],
      },
      load: [{ rate: 1, duration: 4 }],
      arrivalProcess: "deterministic",
      seed: "tie-break",
      mutations: [
        { at: 1.5, kind: "set-spec", nodeId: "s", spec: { service: { kind: "fixed", time: 0.25 } } },
      ],
      bucketWidth: 1,
    };

    const sim = createSimulation(timeline, referenceRegistry({ trace }));
    sim.runUntil(5);

    const at1p5 = trace.filter((line) => line.startsWith("1.500000"));
    expect(at1p5).toEqual(["1.500000 s end:1", "1.500000 s spec-change"]);
  });

  it("keeps the tie-break stable regardless of the order events were scheduled", () => {
    const build = (mutations: Timeline["mutations"]): string => {
      const timeline: Timeline = {
        model: {
          entryId: "s",
          nodes: [{ id: "s", kind: "reference", spec: { service: { kind: "fixed", time: 0.5 } } }],
          edges: [],
        },
        load: [{ rate: 1, duration: 4 }],
        arrivalProcess: "deterministic",
        seed: "tie-break",
        mutations,
        bucketWidth: 1,
      };
      const sim = createSimulation(timeline, referenceRegistry());
      sim.runUntil(5);
      return JSON.stringify(sim.series());
    };

    // Two mutations at the same instant: recorded order is the order applied.
    const forward = build([
      { at: 2.5, kind: "set-spec", nodeId: "s", spec: { service: { kind: "fixed", time: 0.25 } } },
      { at: 2.5, kind: "set-spec", nodeId: "s", spec: { service: { kind: "fixed", time: 0.1 } } },
    ]);
    const reversed = build([
      { at: 2.5, kind: "set-spec", nodeId: "s", spec: { service: { kind: "fixed", time: 0.1 } } },
      { at: 2.5, kind: "set-spec", nodeId: "s", spec: { service: { kind: "fixed", time: 0.25 } } },
    ]);

    expect(forward).not.toBe(reversed);
    expect(build([
      { at: 2.5, kind: "set-spec", nodeId: "s", spec: { service: { kind: "fixed", time: 0.25 } } },
      { at: 2.5, kind: "set-spec", nodeId: "s", spec: { service: { kind: "fixed", time: 0.1 } } },
    ])).toBe(forward);
  });
});

describe("common random numbers (per-node substreams)", () => {
  it("leaves the surviving nodes' behaviour untouched when one node is removed", () => {
    // This is what makes the delta toggle honest: baseline and proposal see the
    // same load realisation and the same per-node service draws, so a
    // difference in outcome is the structure, not a different roll of the dice.
    //
    // Comparing whole per-node series rather than draw counts is deliberate. A
    // single shared generator would give `a` the same *number* of draws here
    // but different *values*, because `b` and `c` would be pulling from the
    // same stream in between — so a count-only assertion would pass on exactly
    // the design this test exists to rule out.
    const run = (ids: string[]): ReturnType<typeof createSimulation> => {
      const sim = createSimulation(baseTimeline({ model: chain(ids), seed: "crn" }), referenceRegistry());
      sim.runUntil(16);
      return sim;
    };
    const seriesFor = (sim: ReturnType<typeof createSimulation>, id: string): string =>
      JSON.stringify(sim.series().map((bucket) => bucket.nodes[id]));

    const full = run(["a", "b", "c"]);
    const cut = run(["a", "b"]);

    expect(seriesFor(full, "a")).toBe(seriesFor(cut, "a"));
    expect(seriesFor(full, "b")).toBe(seriesFor(cut, "b"));

    // Non-vacuity: there was real traffic, and the removal did change the run.
    expect(full.drawCount("a", "service")).toBeGreaterThan(50);
    expect(seriesFor(full, "c")).not.toBe(seriesFor(cut, "c"));

    // A different seed must move `a`, or the streams are not seeded at all.
    const other = createSimulation(
      baseTimeline({ model: chain(["a", "b", "c"]), seed: "different" }),
      referenceRegistry(),
    );
    other.runUntil(16);
    expect(seriesFor(other, "a")).not.toBe(seriesFor(full, "a"));
  });

  it("gives different nodes different draw sequences under the same seed", () => {
    const sim = createSimulation(baseTimeline({ model: chain(["a", "b"]), seed: "crn" }), referenceRegistry());
    const draw = (id: string): number[] =>
      Array.from({ length: 8 }, () => sim.substream(id, "service").nextUnit());

    expect(draw("a")).not.toEqual(draw("b"));
  });
});

describe("degenerate models", () => {
  it("runs an empty model as a clean no-op", () => {
    const sim = createSimulation(
      { model: { entryId: null, nodes: [], edges: [] }, load: [], seed: "empty", mutations: [] },
      referenceRegistry(),
    );

    expect(() => sim.runUntil(10)).not.toThrow();
    expect(sim.now()).toBe(10);
    expect(sim.done()).toBe(true);
    for (const bucket of sim.series()) {
      expect(bucket.system.arrivals).toBe(0);
      expect(bucket.system.completions).toBe(0);
    }
  });

  it("admits nothing across a zero-rate load segment", () => {
    const timeline = baseTimeline({
      model: chain(["a"]),
      load: [{ rate: 0, duration: 5 }, { rate: 6, duration: 5 }],
    });
    const sim = createSimulation(timeline, referenceRegistry());
    sim.runUntil(12);

    const early = sim.series().filter((b) => b.end <= 5);
    expect(early.length).toBe(5);
    expect(early.every((b) => b.system.arrivals === 0)).toBe(true);
    expect(sim.series().some((b) => b.system.arrivals > 0)).toBe(true);
  });
});

describe("retry amplification runs through the arrival machinery", () => {
  it("reissues timed-out jobs as fresh attempts and counts them", () => {
    const timeline: Timeline = {
      model: {
        entryId: "front",
        nodes: [
          {
            id: "front",
            kind: "reference",
            spec: {
              service: { kind: "fixed", time: 0.01 },
              servers: 8,
              timeoutAfter: 0.2,
              maxAttempts: 3,
            },
          },
          {
            id: "slow",
            kind: "reference",
            spec: { service: { kind: "fixed", time: 0.5 }, servers: 1 },
          },
        ],
        edges: [{ from: "front", to: "slow" }],
      },
      load: [{ rate: 10, duration: 5 }],
      seed: "amplify",
      mutations: [],
      bucketWidth: 1,
    };

    const sim = createSimulation(timeline, referenceRegistry());
    sim.runUntil(8);

    const retries = sim.series().reduce((sum, b) => sum + (b.nodes["front"]?.retries ?? 0), 0);
    const arrivals = sim.series().reduce((sum, b) => sum + (b.nodes["front"]?.arrivals ?? 0), 0);

    expect(retries).toBeGreaterThan(0);
    // The point of amplification: the entry sees more work than the load offered.
    expect(arrivals).toBeGreaterThan(50);
  });
});

/**
 * Call/response primitives. These get a purpose-built two-node harness rather
 * than the reference server, because what is under test is the kernel contract —
 * who holds what, and what happens to abandoned work — not any component's
 * interpretation of it.
 */
interface CallProbe {
  outcomes: CallOutcome[];
  sinkFinished: number;
}

function callHarness(options: {
  sinkDelay: number;
  timeout?: number;
  retries?: number;
  sinkDrops?: boolean;
}): { registry: BehaviorRegistry; probe: CallProbe } {
  const probe: CallProbe = { outcomes: [], sinkFinished: 0 };
  const retries = options.retries ?? 0;

  const registry: BehaviorRegistry = {
    caller: () => ({
      accept(job, ctx) {
        const attemptCall = (attempt: number): void => {
          const handle = ctx.call(
            "sink",
            job,
            (outcome) => {
              probe.outcomes.push(outcome);
              if (outcome === "ok") {
                ctx.finish(job);
              } else if (attempt < retries) {
                ctx.recordRetry();
                attemptCall(attempt + 1);
              } else {
                ctx.drop(job, "downstream refused");
              }
            },
            attempt,
          );

          if (options.timeout !== undefined) {
            ctx.schedule(options.timeout, () => {
              if (handle.closed) return;
              handle.abandon();
              ctx.recordTimeout();
              if (attempt < retries) {
                ctx.recordRetry();
                attemptCall(attempt + 1);
              } else {
                ctx.drop(job, "timed out");
              }
            });
          }
        };
        attemptCall(0);
      },
    }),

    sink: () => ({
      accept(job, ctx) {
        ctx.schedule(options.sinkDelay, () => {
          probe.sinkFinished += 1;
          if (options.sinkDrops === true) {
            ctx.drop(job, "refused");
          } else {
            ctx.finish(job);
          }
        });
      },
    }),
  };

  return { registry, probe };
}

function callTimeline(duration: number): Timeline {
  return {
    model: {
      entryId: "caller",
      nodes: [
        { id: "caller", kind: "caller", spec: {} },
        { id: "sink", kind: "sink", spec: {} },
      ],
      edges: [{ from: "caller", to: "sink" }],
    },
    load: [{ rate: 1, duration }],
    arrivalProcess: "deterministic",
    seed: "calls",
    mutations: [],
    bucketWidth: 1,
  };
}

describe("call and response", () => {
  it("keeps the caller holding the request while the callee works", () => {
    // The whole reason call semantics exist: a service upstream of a slow
    // datastore has to *look* as loaded as it really is.
    const { registry } = callHarness({ sinkDelay: 10 });
    const sim = createSimulation(callTimeline(3), registry);
    sim.runUntil(1.5);

    const snapshot = sim.snapshot();
    expect(snapshot.nodes["caller"]?.resident).toBe(1);
    expect(snapshot.nodes["sink"]?.resident).toBe(1);
    expect(sim.series().reduce((n, b) => n + b.system.completions, 0)).toBe(0);
  });

  it("counts child jobs at the node but not as system arrivals", () => {
    // Offered load is what the system was asked to do. Downstream calls are how
    // it chose to do it, and conflating the two would make every multi-hop model
    // look like it was under more load than it was.
    const { registry } = callHarness({ sinkDelay: 0.1 });
    // 5.5 not 5: an arrival landing exactly on a segment boundary belongs to the
    // segment that boundary opens, so rate 1 over [0, 5) offers 4, not 5.
    const sim = createSimulation(callTimeline(5.5), registry);
    sim.runUntil(8);

    const total = (pick: (b: (typeof series)[number]) => number): number =>
      series.reduce((n, b) => n + pick(b), 0);
    const series = sim.series();

    expect(total((b) => b.system.arrivals)).toBe(5);
    expect(total((b) => b.system.completions)).toBe(5);
    expect(total((b) => b.nodes["sink"]?.arrivals ?? 0)).toBe(5);
  });

  it("leaves abandoned work running downstream and discards its result", () => {
    // A timeout does not reach into the callee and stop it. The work carries on,
    // burns capacity, and finishes into nothing.
    const { registry, probe } = callHarness({ sinkDelay: 5, timeout: 2 });
    const sim = createSimulation(callTimeline(1.5), registry);
    sim.runUntil(12);

    const series = sim.series();
    expect(probe.outcomes).toEqual([]); // the caller was never told
    expect(probe.sinkFinished).toBe(1); // but the callee did the work anyway
    expect(series.reduce((n, b) => n + b.system.drops, 0)).toBe(1);
    expect(series.reduce((n, b) => n + b.system.completions, 0)).toBe(0);
    expect(series.reduce((n, b) => n + (b.nodes["sink"]?.departures ?? 0), 0)).toBe(1);
  });

  it("multiplies downstream arrivals when a caller retries a timed-out call", () => {
    // One offered request, three units of downstream work. This is the whole
    // mechanism of a retry storm, arrived at without the engine staging it.
    const { registry, probe } = callHarness({ sinkDelay: 5, timeout: 1, retries: 2 });
    const sim = createSimulation(callTimeline(1.5), registry);
    sim.runUntil(15);

    const series = sim.series();
    expect(series.reduce((n, b) => n + b.system.arrivals, 0)).toBe(1);
    expect(series.reduce((n, b) => n + (b.nodes["sink"]?.arrivals ?? 0), 0)).toBe(3);
    expect(series.reduce((n, b) => n + (b.nodes["caller"]?.retries ?? 0), 0)).toBe(2);
    expect(probe.sinkFinished).toBe(3);
    expect(series.reduce((n, b) => n + b.system.drops, 0)).toBe(1);
  });

  it("surfaces a callee's drop to the caller as a failed call", () => {
    const { registry, probe } = callHarness({ sinkDelay: 0.1, sinkDrops: true });
    const sim = createSimulation(callTimeline(1.5), registry);
    sim.runUntil(5);

    const series = sim.series();
    expect(probe.outcomes).toEqual(["dropped"]);
    expect(series.reduce((n, b) => n + (b.nodes["sink"]?.drops ?? 0), 0)).toBe(1);
    expect(series.reduce((n, b) => n + b.system.drops, 0)).toBe(1);
    expect(series.reduce((n, b) => n + b.system.completions, 0)).toBe(0);
  });

  it("replays a run built on calls, retries and abandonment exactly", () => {
    const run = (): string => {
      const { registry } = callHarness({ sinkDelay: 5, timeout: 1, retries: 2 });
      const sim = createSimulation(callTimeline(6), registry);
      sim.runUntil(20);
      return JSON.stringify(sim.series());
    };

    expect(run()).toBe(run());
  });
});

describe("kernel independence", () => {
  it("imports no DOM and no renderer", async () => {
    const dir = resolve(process.cwd(), "src/engine");
    const files = (await readdir(dir)).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));
    expect(files.length).toBeGreaterThan(4);

    for (const file of files) {
      const source = await readFile(resolve(dir, file), "utf8");
      const imports = [...source.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1] as string);
      const foreign = imports.filter((spec) => !spec.startsWith("./") && !spec.startsWith("../"));
      expect(foreign, `${file} imports ${foreign.join(", ")}`).toEqual([]);

      const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
      expect(code, `${file} touches the DOM`).not.toMatch(/\b(document|window|requestAnimationFrame)\b/);
    }
  });
});
