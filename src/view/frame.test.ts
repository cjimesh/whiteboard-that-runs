import { describe, expect, it } from "vitest";
import { createModelSimulation } from "../specs/registry.ts";
import type { Simulation } from "../engine/kernel.ts";
import type { Timeline } from "../engine/timeline.ts";
import { emptyFrame, frameFor, sampleWire, type EdgeFrame, type Frame } from "./frame.ts";

/**
 * The frame is where the screen's judgements live, so this is where they are
 * checked. No canvas is involved — that is the point of the split. If a claim
 * the screen makes cannot be asserted here, it is in the wrong file.
 */

function timeline(overrides: Partial<Timeline> = {}): Timeline {
  return {
    model: {
      entryId: "api",
      nodes: [
        {
          id: "api",
          kind: "service",
          spec: {
            concurrency: 4,
            service: { policy: "fixed", mean: 0.01 },
            queue: { policy: "fifo", capacity: 20 },
            timeout: { policy: "none", after: 1 },
            retry: { policy: "none", attempts: 0, delay: 0, factor: 2, maxDelay: 1 },
          },
        },
        {
          id: "db",
          kind: "datastore",
          spec: {
            concurrency: 1,
            service: { policy: "exponential", mean: 0.02 },
            queue: { policy: "fifo", capacity: 25 },
          },
        },
      ],
      edges: [{ from: "api", to: "db" }],
    },
    load: [{ rate: 30, duration: 600 }],
    seed: "frame",
    mutations: [],
    bucketWidth: 0.25,
    ...overrides,
  };
}

function frameAt(seconds: number, options: Partial<Timeline> = {}): { frame: Frame; sim: Simulation } {
  const sim = createModelSimulation(timeline(options));
  sim.runUntil(seconds);
  return {
    frame: frameFor({ model: sim.recorded().model, snapshot: sim.snapshot(), series: sim.series() }),
    sim,
  };
}

const nodeIn = (frame: Frame, id: string): Frame["nodes"][number] => {
  const node = frame.nodes.find((candidate) => candidate.id === id);
  if (node === undefined) throw new Error(`no node ${id} in frame`);
  return node;
};

describe("purity", () => {
  it("produces the same frame from the same state, every time", () => {
    const sim = createModelSimulation(timeline());
    sim.runUntil(12);
    const input = { model: sim.recorded().model, snapshot: sim.snapshot(), series: sim.series() };

    expect(JSON.stringify(frameFor(input))).toBe(JSON.stringify(frameFor(input)));
  });

  it("needs no canvas and no DOM", () => {
    // This test file runs in the node environment; reaching for a document here
    // would throw rather than quietly working.
    expect(typeof globalThis.document).toBe("undefined");
    expect(frameAt(8).frame.nodes).toHaveLength(2);
  });

  it("covers every component and every wire", () => {
    const { frame } = frameAt(8);
    expect(frame.nodes.map((node) => node.id)).toEqual(["api", "db"]);
    expect(frame.edges).toHaveLength(1);
    expect(frame.edges[0]).toMatchObject({ from: "api", to: "db" });
  });
});

describe("what the gauges say", () => {
  it("reports utilization against declared capacity, not raw busy count", () => {
    // db is one server at 20 ms serving 30/s: rho = 0.6.
    //
    // api is the more interesting one. Four servers doing 10 ms of their own work
    // at 30/s would sit at 0.075 — but it calls the database and waits, holding a
    // server through the round trip, so its real occupancy is 30 × (10 ms + the
    // db's 50 ms sojourn) / 4 ≈ 0.45. That number is the call-and-wait semantic
    // showing up in the gauge, and it is the reason a service in front of a loaded
    // datastore reads as loaded instead of idle.
    //
    // Averaged over a long window: rho is a steady-state quantity, and over the
    // default 1.5 s live window a single server's busy fraction swings widely.
    const sim = createModelSimulation(timeline());
    sim.runUntil(300);
    const frame = frameFor({
      model: sim.recorded().model,
      snapshot: sim.snapshot(),
      series: sim.series(),
      window: 250,
    });

    expect(nodeIn(frame, "db").utilization).toBeGreaterThan(0.57);
    expect(nodeIn(frame, "db").utilization).toBeLessThan(0.63);
    const api = nodeIn(frame, "api");
    expect(api.utilization).toBeGreaterThan(0.25); // far above the 0.075 of its own work
    expect(api.utilization).toBeLessThan(0.6);
  });

  it("scales queue fill against the buffer's own capacity", () => {
    const { frame } = frameAt(60);
    const db = nodeIn(frame, "db");
    expect(db.capacity).toBe(25);
    expect(db.queueFill).toBeCloseTo(Math.min(1, db.queueDepth / 25), 10);
  });

  it("treats a balancer as having no queue at all", () => {
    const { frame } = frameAt(20, {
      model: {
        entryId: "lb",
        nodes: [
          { id: "lb", kind: "balancer", spec: { balancer: { policy: "round-robin" } } },
          { id: "api", kind: "service", spec: { concurrency: 8, service: { policy: "fixed", mean: 0.005 } } },
        ],
        edges: [{ from: "lb", to: "api" }],
      },
    });

    const lb = nodeIn(frame, "lb");
    expect(lb.capacity).toBe(Number.POSITIVE_INFINITY);
    expect(lb.queueFill).toBe(0);
    expect(lb.throughput).toBeGreaterThan(20);
  });

  it("averages rates over a trailing window rather than the newest bucket", () => {
    // With 0.25 s buckets and 30/s offered, a single bucket holds about seven
    // completions. A gauge driven off one bucket flickers; the window steadies it.
    const { sim } = frameAt(60);
    const input = { model: sim.recorded().model, snapshot: sim.snapshot(), series: sim.series() };

    const narrow = frameFor({ ...input, window: 0.25 });
    const wide = frameFor({ ...input, window: 8 });

    expect(wide.system.offered).toBeGreaterThan(20);
    expect(wide.system.offered).toBeLessThan(40);
    // The wide window cannot be more jagged than the narrow one; assert it is at
    // least as close to the offered rate the load actually specifies.
    expect(Math.abs(wide.system.offered - 30)).toBeLessThanOrEqual(
      Math.abs(narrow.system.offered - 30) + 1e-9,
    );
  });

  it("reports goodput separately from offered load", () => {
    const { frame } = frameAt(60);
    expect(frame.system.offered).toBeGreaterThan(20);
    expect(frame.system.goodput).toBeGreaterThan(20);
    expect(frame.system.dropRate).toBe(0);
  });
});

describe("health is a visual signal, not the verdict", () => {
  it("reads healthy at comfortable load", () => {
    const { frame } = frameAt(60);
    expect(nodeIn(frame, "api").health).toBe("ok");
  });

  it("reads folding once a component is shedding work", () => {
    const { frame } = frameAt(40, {
      model: {
        entryId: "db",
        nodes: [
          {
            id: "db",
            kind: "datastore",
            spec: {
              concurrency: 1,
              service: { policy: "fixed", mean: 0.05 },
              queue: { policy: "fifo", capacity: 4 },
            },
          },
        ],
        edges: [],
      },
      load: [{ rate: 60, duration: 600 }],
    });

    const db = nodeIn(frame, "db");
    expect(db.dropRate).toBeGreaterThan(0);
    expect(db.health).toBe("fold");
  });

  it("reads straining, not folding, when a component is saturated but coping", () => {
    // rho = 0.92 with room to queue: latency is high and nothing is lost. Calling
    // this red would mean the demo spiral lit up every busy component and hid the
    // one that was actually failing.
    const { frame } = frameAt(60, {
      model: {
        entryId: "db",
        nodes: [
          {
            id: "db",
            kind: "datastore",
            spec: {
              concurrency: 1,
              service: { policy: "exponential", mean: 0.022 },
              queue: { policy: "fifo", capacity: 10_000 },
            },
          },
        ],
        edges: [],
      },
      load: [{ rate: 42, duration: 600 }],
    });

    expect(nodeIn(frame, "db").health).toBe("strain");
    expect(nodeIn(frame, "db").dropRate).toBe(0);
  });
});

describe("ribbons", () => {
  it("thickens with throughput, sub-linearly so quiet wires stay visible", () => {
    const widthAt = (rate: number): number => {
      const { frame } = frameAt(40, { load: [{ rate, duration: 600 }] });
      return frame.edges[0]?.width ?? 0;
    };

    const quiet = widthAt(4);
    const busy = widthAt(40);

    expect(busy).toBeGreaterThan(quiet);
    expect(quiet).toBeGreaterThan(1); // never invisible
    // Square-root scaling: a tenfold rate increase must not be a tenfold width.
    expect(busy / quiet).toBeLessThan(6);
  });

  it("measures a dependency at its source, times the calls per request", () => {
    // A hand-off is measured at its target, which is fine while a target has one
    // inbound wire. A shared dependency is exactly where that stops being true:
    // two callers share its arrivals, and drawing each wire at the shared total
    // would tell the room every caller was sending twice what it sends.
    const { frame } = frameAt(40, {
      model: {
        entryId: "lb",
        nodes: [
          { id: "lb", kind: "balancer", spec: { balancer: { policy: "round-robin" } } },
          { id: "a", kind: "service", spec: { concurrency: 50, service: { policy: "fixed", mean: 0.001 } } },
          { id: "b", kind: "service", spec: { concurrency: 50, service: { policy: "fixed", mean: 0.001 } } },
          { id: "spine", kind: "datastore", spec: { concurrency: 20, service: { policy: "fixed", mean: 0.001 } } },
        ],
        edges: [
          { from: "lb", to: "a" },
          { from: "lb", to: "b" },
          { from: "a", to: "spine", kind: "call", times: 3 },
          { from: "b", to: "spine", kind: "call", times: 3 },
        ],
      },
      load: [{ rate: 20, duration: 600 }],
    });

    const calls = frame.edges.filter((edge) => edge.kind === "call");
    expect(calls).toHaveLength(2);

    // Each caller takes half of 20/s and calls three times: about 30/s per wire,
    // not the 60/s the shared node receives in total.
    for (const edge of calls) {
      expect(edge.throughput).toBeGreaterThan(20);
      expect(edge.throughput).toBeLessThan(45);
    }
  });

  it("marks a hand-off as one, so the renderer can draw the difference", () => {
    const { frame } = frameAt(20);

    expect(frame.edges[0]?.kind).toBe("forward");
  });
});

describe("the legend explains only what this model uses", () => {
  it("mentions retries only when something retries", () => {
    const without = frameAt(20).frame.legend.map((item) => item.swatch);
    expect(without).not.toContain("retries");

    const withRetries = frameAt(20, {
      model: {
        ...timeline().model,
        nodes: [
          {
            id: "api",
            kind: "service",
            spec: {
              concurrency: 4,
              service: { policy: "fixed", mean: 0.01 },
              queue: { policy: "fifo", capacity: 20 },
              timeout: { policy: "fixed", after: 0.2 },
              retry: { policy: "exponential", attempts: 2, delay: 0.05, factor: 2, maxDelay: 1 },
            },
          },
          ...timeline().model.nodes.slice(1),
        ],
      },
    }).frame.legend.map((item) => item.swatch);

    expect(withRetries).toContain("retries");
  });

  it("mentions a cache only when there is one, and calls its ratio an input", () => {
    const legend = frameAt(20, {
      model: {
        entryId: "cache",
        nodes: [
          {
            id: "cache",
            kind: "cache",
            spec: { concurrency: 20, service: { policy: "fixed", mean: 0.001 }, cache: { policy: "fixed-ratio", hitRatio: 0.8 } },
          },
        ],
        edges: [],
      },
    }).frame.legend;

    const cache = legend.find((item) => item.swatch === "cache");
    expect(cache).toBeDefined();
    expect(cache?.meaning).toMatch(/input/);
  });

  it("always explains the three encodings every model uses", () => {
    const swatches = frameAt(20).frame.legend.map((item) => item.swatch);
    expect(swatches).toContain("utilization");
    expect(swatches).toContain("queue");
    expect(swatches).toContain("ribbon");
  });
});

describe("degenerate states", () => {
  it("survives a frame taken before anything has happened", () => {
    const sim = createModelSimulation(timeline());
    const frame = frameFor({ model: sim.recorded().model, snapshot: sim.snapshot(), series: sim.series() });

    expect(frame.time).toBe(0);
    expect(frame.nodes).toHaveLength(2);
    expect(frame.system.goodput).toBe(0);
  });

  it("survives an empty model", () => {
    const sim = createModelSimulation({
      model: { entryId: null, nodes: [], edges: [] },
      load: [],
      seed: "empty",
      mutations: [],
    });
    sim.runUntil(5);
    const frame = frameFor({ model: sim.recorded().model, snapshot: sim.snapshot(), series: sim.series() });

    expect(frame.nodes).toEqual([]);
    expect(frame.edges).toEqual([]);
    expect(frame.legend.length).toBeGreaterThan(0);
  });
});

describe("naming what folded first", () => {
  /**
   * The failure this exists for: trouble propagates backwards through a
   * call-and-wait graph, so one saturated component reddens everything in front
   * of it and the picture accuses the innocent along with the guilty.
   */
  it("says nothing while nothing is folding", () => {
    const { frame } = frameAt(20, { load: [{ rate: 8, duration: 600 }] });

    expect(frame.culprit).toBeNull();
    expect(frame.nodes.every((node) => node.role === null)).toBe(true);
  });

  /**
   * A caller with plenty of threads, a datastore with one connection, and
   * retries on a short timeout — the shape the demo uses. Both tiers go red and
   * only the datastore is the cause.
   */
  const overloadedDatastore = {
    model: {
      entryId: "api",
      nodes: [
        {
          id: "api",
          kind: "service",
          spec: {
            concurrency: 200,
            service: { policy: "fixed", mean: 0.002 },
            queue: { policy: "fifo", capacity: 5000 },
            timeout: { policy: "fixed", after: 0.25 },
            retry: { policy: "exponential", attempts: 3, delay: 0.05, factor: 2, maxDelay: 5 },
          },
        },
        {
          id: "db",
          kind: "datastore",
          spec: { concurrency: 1, service: { policy: "exponential", mean: 0.02 }, queue: { policy: "fifo", capacity: 30 } },
        },
      ],
      edges: [{ from: "api", to: "db" }],
    },
    load: [{ rate: 44, duration: 600 }],
  };

  it("blames the datastore, not the service waiting on it", () => {
    const { frame } = frameAt(60, overloadedDatastore);

    expect(frame.culprit?.id).toBe("db");
    expect(nodeIn(frame, "db").role).toBe("origin");
    expect(frame.culprit?.carrying).toContain("api");
    expect(nodeIn(frame, "api").role).toBe("carrier");
  });

  it("states the cause in the component's own numbers", () => {
    const { frame } = frameAt(60, overloadedDatastore);
    expect(frame.culprit?.reason).toMatch(/queue is full|losing|at capacity/);
  });

  it("blames the caller when its own threads are the limit", () => {
    // Measured, and it corrected this test's first assumption. Four threads held
    // while the datastore answers means the api cannot push enough concurrent
    // calls to overload it: the api drops 9/s with the datastore's queue at 3 of
    // 25 and nothing lost. The caller is genuinely the cause, and the rule has
    // to say so rather than always blaming the deepest component.
    const { frame } = frameAt(40, {
      model: {
        entryId: "api",
        nodes: [
          {
            id: "api",
            kind: "service",
            spec: {
              concurrency: 1,
              service: { policy: "fixed", mean: 0.2 },
              queue: { policy: "fifo", capacity: 5 },
              timeout: { policy: "none", after: 1 },
              retry: { policy: "none", attempts: 0, delay: 0, factor: 2, maxDelay: 1 },
            },
          },
          {
            id: "db",
            kind: "datastore",
            spec: { concurrency: 8, service: { policy: "fixed", mean: 0.001 }, queue: { policy: "fifo", capacity: 500 } },
          },
        ],
        edges: [{ from: "api", to: "db" }],
      },
      load: [{ rate: 30, duration: 600 }],
    });

    expect(frame.culprit?.id).toBe("api");
    expect(nodeIn(frame, "db").health).not.toBe("fold");
  });

  it("names somebody even when a cycle means everything has a folding successor", () => {
    // Two services calling each other is a real shape, and the rule "no folding
    // node behind you" picks nobody in a cycle. Depth settles it rather than
    // leaving the room with four red boxes and no answer.
    const spec = {
      concurrency: 1,
      service: { policy: "fixed", mean: 0.2 },
      queue: { policy: "fifo", capacity: 3 },
      timeout: { policy: "none", after: 1 },
      retry: { policy: "none", attempts: 0, delay: 0, factor: 2, maxDelay: 1 },
    };
    const { frame } = frameAt(30, {
      model: {
        entryId: "a",
        nodes: [
          { id: "a", kind: "service", spec },
          { id: "b", kind: "service", spec },
        ],
        edges: [
          { from: "a", to: "b" },
          { from: "b", to: "a" },
        ],
      },
      load: [{ rate: 25, duration: 600 }],
    });

    expect(frame.culprit).not.toBeNull();
    expect(frame.nodes.filter((node) => node.role === "origin")).toHaveLength(1);
  });

  it("agrees with itself: exactly one origin, and every other folding node carries it", () => {
    const { frame } = frameAt(60, overloadedDatastore);
    const folding = frame.nodes.filter((node) => node.health === "fold");

    expect(folding.filter((node) => node.role === "origin")).toHaveLength(1);
    expect(folding.filter((node) => node.role === "carrier").map((node) => node.id).sort()).toEqual(
      [...(frame.culprit?.carrying ?? [])].sort(),
    );
  });
});

describe("other traffic on a shared component", () => {
  const shared = { id: "neighbours", name: "everything else on the database", nodeId: "db", rate: 40 };

  it("says how much of a component's load came from outside the drawing", () => {
    const { frame } = frameAt(8, { model: { ...timeline().model, sources: [shared] } });
    const db = nodeIn(frame, "db");

    expect(db.otherTraffic).not.toBeNull();
    // Averaged over the same trailing window as every other rate on screen, so
    // it is comparable to the throughput printed inside the box.
    expect(db.otherTraffic?.offered).toBeGreaterThan(25);
    expect(db.otherTraffic?.offered).toBeLessThan(55);
  });

  it("leaves it null on components nothing else leans on", () => {
    const { frame } = frameAt(8, { model: { ...timeline().model, sources: [shared] } });
    expect(nodeIn(frame, "api").otherTraffic).toBeNull();
  });

  it("draws the stub on the same scale as the wires, so the two compare by eye", () => {
    const { frame } = frameAt(8, { model: { ...timeline().model, sources: [shared] } });
    const db = nodeIn(frame, "db");
    const inbound = frame.edges.find((edge) => edge.to === "db");

    // Its own arrivals are ~30/s and the other traffic ~40/s: a thicker stub
    // than the wire is the picture saying most of this load is not ours.
    expect(db.otherTraffic?.width).toBeGreaterThan(inbound?.width ?? 0);
  });

  it("keeps the wire into the spine showing what its sender sends", () => {
    // The defect this guards: a hand-off ribbon is measured at the target's
    // arrivals, and a spine's arrivals include the load nobody drew. Charged to
    // the wire, it would tell the room the api is sending more than it sends —
    // on exactly the picture where the room is looking for a cause.
    //
    // Light other traffic on purpose: 30 + 10 against a database that does 50/s
    // leaves the api's own flow untouched, so any change in this ribbon is the
    // accounting and not contention. (At 40/s it drops for real — the database
    // is over its capacity and the api genuinely gets less through.)
    const plain = frameAt(8).frame;
    const alongside = frameAt(8, {
      model: { ...timeline().model, sources: [{ ...shared, rate: 10 }] },
    }).frame;

    const wire = (frame: Frame): number =>
      frame.edges.find((edge) => edge.to === "db")?.throughput ?? 0;

    expect(wire(alongside)).toBeCloseTo(wire(plain), 0);
  });

  it("explains the stub in the legend, and only when there is one", () => {
    const withTraffic = frameAt(4, { model: { ...timeline().model, sources: [shared] } }).frame;
    expect(withTraffic.legend.map((item) => item.swatch)).toContain("other-traffic");
    expect(frameAt(4).frame.legend.map((item) => item.swatch)).not.toContain("other-traffic");
  });

  it("shows the stated rate in the editor, before anything has run", () => {
    // Not a measurement — an input, like capacity and concurrency, which the
    // editor already draws. An author who types 40 should see 40 on the canvas.
    const frame = emptyFrame({ ...timeline().model, sources: [shared] });
    expect(nodeIn(frame, "db").otherTraffic).toMatchObject({ offered: 40, turnedAway: 0 });
    expect(nodeIn(frame, "api").otherTraffic).toBeNull();
  });

  it("reports what the component turned away, so traffic that never lands is visible", () => {
    const { frame } = frameAt(8, {
      model: { ...timeline().model, sources: [{ ...shared, rate: 400 }] },
    });
    expect(nodeIn(frame, "db").otherTraffic?.turnedAway).toBeGreaterThan(0);
  });
});

describe("wires that would cross a box", () => {
  const chain = (extra: { from: string; to: string; kind?: "call" }[]): Frame =>
    emptyFrame({
      entryId: "a",
      nodes: ["a", "b", "c"].map((id) => ({ id, kind: "service" as const, spec: {} })),
      edges: [{ from: "a", to: "b" }, { from: "b", to: "c" }, ...extra],
    } as never);
  const inside = (point: { x: number; y: number }, place: { x: number; y: number; w: number; h: number }): boolean =>
    point.x > place.x && point.x < place.x + place.w && point.y > place.y && point.y < place.y + place.h;

  it("leaves a wire with a clear path alone", () => {
    const frame = chain([]);
    expect(frame.edges.every((edge) => edge.lane === undefined)).toBe(true);
  });

  it("leaves a long chain's wires alone, however narrow its gaps", () => {
    // Twelve columns leave gaps narrower than a detour's turns. A rule that read
    // a narrow gap as a wire running backwards detoured every wire in a model.
    const ids = Array.from({ length: 12 }, (_, i) => `n${i}`);
    const frame = emptyFrame({
      entryId: "n0",
      nodes: ids.map((id) => ({ id, kind: "service" as const, spec: {} })),
      edges: ids.slice(1).map((id, i) => ({ from: ids[i] as string, to: id })),
    } as never);
    expect(frame.edges.filter((edge) => edge.lane !== undefined)).toEqual([]);
  });

  it("routes a wire that skips a column round the box between, not through it", () => {
    // Drawn straight, a → c runs behind b and reads as b's wire.
    const frame = chain([{ from: "a", to: "c", kind: "call" }]);
    const skip = frame.edges.find((edge) => edge.from === "a" && edge.to === "c");
    const b = nodeIn(frame, "b").place;
    expect(skip?.lane).toBeDefined();
    expect(sampleWire(skip as EdgeFrame).some((point) => inside(point, b))).toBe(false);
    const { lane: _lane, ...straight } = skip as EdgeFrame;
    expect(sampleWire(straight).some((point) => inside(point, b))).toBe(true);
  });

  it("routes a wire back to an earlier column round the boxes it passes", () => {
    // A loop: layering decides which of its wires ends up running leftward.
    const frame = chain([{ from: "c", to: "a", kind: "call" }]);
    const leftward = frame.edges.filter((edge) => edge.x2 < edge.x1);
    expect(leftward.length).toBeGreaterThan(0);
    for (const edge of leftward) {
      expect(edge.lane).toBeDefined();
      for (const node of frame.nodes) {
        expect(sampleWire(edge).filter((point) => inside(point, node.place))).toEqual([]);
      }
    }
  });

  it("puts two detours on the same side on separate lanes", () => {
    const frame = chain([
      { from: "a", to: "c", kind: "call" },
      { from: "c", to: "a", kind: "call" },
    ]);
    const lanes = frame.edges.filter((edge) => edge.lane !== undefined).map((edge) => edge.lane);
    expect(new Set(lanes).size).toBe(lanes.length);
  });
});
