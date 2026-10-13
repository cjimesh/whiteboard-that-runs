import { describe, expect, it } from "vitest";
import {
  addComponent,
  addTrafficSource,
  connect,
  disconnect,
  emptyDocument,
  pointsBackwards,
  removeComponent,
  removeTrafficSource,
  setDisputed,
  setEntry,
  loadPatternOf,
  setLoad,
  setPattern,
  setPatternKind,
  setProposal,
  setSpec,
  setTrafficSource,
  toTimeline,
  validateDocument,
  type WhiteboardDocument,
} from "./document.ts";
import { createModelSimulation } from "../specs/registry.ts";

/** A balancer in front of two services, all hitting one datastore. */
function demoShape(): WhiteboardDocument {
  let doc = emptyDocument("orders");
  doc = addComponent(doc, { kind: "balancer" }).document;
  doc = addComponent(doc, { kind: "service" }).document;
  doc = addComponent(doc, { kind: "service" }).document;
  doc = addComponent(doc, { kind: "datastore" }).document;
  doc = connect(doc, "balancer-1", "service-1");
  doc = connect(doc, "balancer-1", "service-2");
  doc = connect(doc, "service-1", "datastore-1");
  doc = connect(doc, "service-2", "datastore-1");
  return doc;
}

describe("building a model", () => {
  it("names components readably, because every error message points at one", () => {
    const doc = demoShape();
    expect(doc.components.map((c) => c.id)).toEqual([
      "balancer-1",
      "service-1",
      "service-2",
      "datastore-1",
    ]);
  });

  it("makes the first component the entry, so a one-component model runs", () => {
    const doc = addComponent(emptyDocument(), { kind: "service" }).document;
    expect(doc.entryId).toBe("service-1");
  });

  it("reuses a freed name rather than counting forever", () => {
    let doc = addComponent(emptyDocument(), { kind: "service" }).document;
    doc = addComponent(doc, { kind: "service" }).document;
    doc = removeComponent(doc, "service-1");
    expect(addComponent(doc, { kind: "service" }).id).toBe("service-1");
  });

  it("takes an edge's wires with it when a component is removed", () => {
    const doc = removeComponent(demoShape(), "datastore-1");

    expect(doc.edges).toEqual([
      { from: "balancer-1", to: "service-1" },
      { from: "balancer-1", to: "service-2" },
    ]);
    expect(validateDocument(doc).ok).toBe(true);
  });

  it("hands the entry to somebody else when the entry is removed", () => {
    const doc = removeComponent(demoShape(), "balancer-1");
    expect(doc.entryId).toBe("service-1");
  });

  it("refuses to draw a wire twice, or from a component to itself", () => {
    const doc = demoShape();
    expect(connect(doc, "service-1", "datastore-1")).toBe(doc);
    expect(connect(doc, "service-1", "service-1")).toBe(doc);
  });

  it("never edits the document it was given", () => {
    const before = demoShape();
    const snapshot = JSON.stringify(before);

    addComponent(before, { kind: "cache" });
    removeComponent(before, "service-1");
    connect(before, "service-1", "service-2");
    disconnect(before, "service-1", "datastore-1");
    setSpec(before, "service-1", { concurrency: 9 });
    setLoad(before, [{ rate: 1, duration: 1 }]);

    expect(JSON.stringify(before)).toBe(snapshot);
  });
});

describe("refusing to run what cannot be run", () => {
  const errorsFor = (doc: WhiteboardDocument): string => validateDocument(doc).errors.join(" | ");

  it("accepts a well-formed model", () => {
    expect(validateDocument(demoShape())).toEqual({ ok: true, errors: [] });
  });

  it("says what to do with an empty model", () => {
    expect(errorsFor(emptyDocument())).toMatch(/empty.*palette/i);
  });

  it("names the component a dangling wire points at", () => {
    const doc = { ...demoShape(), edges: [{ from: "service-1", to: "cache-9" }] };
    expect(errorsFor(doc)).toMatch(/"service-1" → "cache-9" points at "cache-9", which is not in this model/);
  });

  it("names a component nobody wired", () => {
    const doc = addComponent(demoShape(), { kind: "cache" }).document;
    expect(errorsFor(doc)).toMatch(/"cache-1" is not wired to anything/);
  });

  it("names a component the entry cannot reach", () => {
    // Wired, but only backwards into the graph.
    let doc = addComponent(demoShape(), { kind: "cache" }).document;
    doc = connect(doc, "cache-1", "datastore-1");
    expect(errorsFor(doc)).toMatch(/Nothing sends requests to "cache-1". They come in at balancer-1/);
  });

  it("names the arrow into the front of the system as the one to flip", () => {
    let doc = addComponent(demoShape(), { kind: "service" }).document;
    doc = connect(doc, "service-3", "balancer-1");
    doc = connect(doc, "service-3", "datastore-1", "call");
    expect(errorsFor(doc)).toMatch(/its arrow to balancer-1 points away from it/);
  });

  it("says plainly when nothing leads to a component, without blaming the entry", () => {
    // Wired only from something that is itself stranded: no arrow to flip.
    let doc = addComponent(demoShape(), { kind: "cache" }).document;
    doc = addComponent(doc, { kind: "cache" }).document;
    doc = connect(doc, "cache-1", "cache-2");
    const message = validateDocument(doc).errors.find((error) => error.includes('"cache-2"')) ?? "";
    expect(message).toMatch(/no arrow leads from there to it/);
    expect(message).not.toMatch(/"balancer-1"/);
  });

  it("knows an arrow drawn the wrong way round, and not its neighbours", () => {
    let doc = addComponent(demoShape(), { kind: "service" }).document;
    doc = connect(doc, "service-3", "balancer-1");
    doc = connect(doc, "service-3", "datastore-1", "call");
    expect(pointsBackwards(doc, "service-3", "balancer-1")).toBe(true);
    // Stranded too, but calling its database is right: the arrow to fix is the other one.
    expect(pointsBackwards(doc, "service-3", "datastore-1")).toBe(false);
    expect(pointsBackwards(doc, "balancer-1", "service-1")).toBe(false);
  });

  it("refuses a loop with no way out, and says how to fix it", () => {
    let doc = emptyDocument();
    doc = addComponent(doc, { kind: "service" }).document;
    doc = addComponent(doc, { kind: "service" }).document;
    doc = connect(doc, "service-1", "service-2");
    doc = connect(doc, "service-2", "service-1");

    // Measured against the kernel: this runs, nothing ever completes, and
    // in-flight work climbs. Running is what makes it worth refusing.
    expect(errorsFor(doc)).toMatch(/loop with no way out.*never finishes/);
    expect(errorsFor(doc)).toMatch(/outside the loop/);
  });

  it("allows a loop traffic can leave", () => {
    let doc = emptyDocument();
    doc = addComponent(doc, { kind: "balancer" }).document;
    doc = addComponent(doc, { kind: "service" }).document;
    doc = addComponent(doc, { kind: "datastore" }).document;
    doc = connect(doc, "balancer-1", "service-1");
    doc = connect(doc, "service-1", "balancer-1");
    doc = connect(doc, "balancer-1", "datastore-1");

    expect(validateDocument(doc).ok).toBe(true);
  });

  it("passes on the wiring rule the components themselves impose", () => {
    // A service hands work on to one place; fan-out is the balancer's job.
    const doc = connect(demoShape(), "service-1", "service-2");
    expect(errorsFor(doc)).toMatch(/hands work on to 2 places/);
  });

  it("allows the same two edges when they are dependencies it calls", () => {
    // The rule polices where work goes next, not what a component leans on.
    const doc = connect(demoShape(), "service-1", "service-2", "call");
    expect(validateDocument(doc).ok).toBe(true);
  });

  it("names the entry problem rather than failing silently", () => {
    expect(errorsFor({ ...demoShape(), entryId: null })).toMatch(/entry point/i);
    expect(errorsFor({ ...demoShape(), entryId: "ghost" })).toMatch(/"ghost" is not in this model/);
  });

  it("checks the load, and says which step is wrong", () => {
    expect(errorsFor(setLoad(demoShape(), [{ rate: 5, duration: 0 }]))).toMatch(/load step 1 lasts 0s/);
    expect(errorsFor(setLoad(demoShape(), [{ rate: -1, duration: 5 }]))).toMatch(/load step 1 has a rate of -1/);
    expect(errorsFor(setLoad(demoShape(), []))).toMatch(/no load to offer/i);
  });

  it("names a setting a component cannot use", () => {
    const doc = setSpec(demoShape(), "datastore-1", { retry: { policy: "fixed", attempts: 2, delay: 0.1, factor: 2, maxDelay: 1 } });
    expect(errorsFor(doc)).toMatch(/"datastore-1" has a setting this datastore cannot use/);
  });
});

describe("running what was drawn", () => {
  it("projects to a timeline the engine accepts, and it runs", () => {
    const doc = setEntry(demoShape(), "balancer-1");
    const sim = createModelSimulation(toTimeline(doc));
    sim.runUntil(10);

    expect(sim.now()).toBe(10);
    const completions = sim.series().reduce((total, bucket) => total + bucket.system.completions, 0);
    expect(completions).toBeGreaterThan(0);
  });

  it("carries no history into the run: a document is a design, not a session", () => {
    expect(toTimeline(demoShape()).mutations).toEqual([]);
  });

  it("keeps the load the author composed", () => {
    const load = [
      { rate: 200, duration: 120 },
      { rate: 800, duration: 30 },
      { rate: 200, duration: 120 },
    ];
    expect(toTimeline(setLoad(demoShape(), load)).load).toEqual(load);
  });
});


describe("marking a proposal", () => {
  it("marks and unmarks without touching anything else", () => {
    const marked = setProposal(demoShape(), "datastore-1", true);

    expect(marked.delta).toEqual(["datastore-1"]);
    expect(marked.components).toEqual(demoShape().components);
    expect(setProposal(marked, "datastore-1", false).delta).toEqual([]);
  });

  it("drops the mark when the component goes", () => {
    // A mark pointing at something that no longer exists is a stored reference to
    // nothing — the shape that turns into a crash a month later.
    let doc = setProposal(demoShape(), "datastore-1", true);
    doc = removeComponent(doc, "datastore-1");

    expect(doc.delta).toEqual([]);
  });

  it("refuses a proposal that swallows the entry point", () => {
    const doc = setProposal(demoShape(), "balancer-1", true);

    expect(validateDocument(doc).errors.join(" ")).toMatch(/entry point.*cannot be part of the proposal/);
  });

  it("refuses a proposal with no baseline left behind it", () => {
    let doc = demoShape();
    for (const component of doc.components) doc = setProposal(doc, component.id, true);

    expect(validateDocument(doc).errors.join(" ")).toMatch(/no baseline left/);
  });

  it("refuses a mark on something that is not in the model", () => {
    const doc = { ...demoShape(), delta: ["ghost"] };

    expect(validateDocument(doc).errors.join(" ")).toMatch(/"ghost" is marked as part of the proposal/);
  });
});

describe("disputing a number", () => {
  const range = { componentId: "datastore-1", field: "capacity", min: 40, max: 60 };

  it("accepts a range the parameter can actually take", () => {
    expect(validateDocument(setDisputed(demoShape(), range)).ok).toBe(true);
  });

  it("refuses a range that is the wrong way round", () => {
    const doc = setDisputed(demoShape(), { ...range, min: 60, max: 40 });

    expect(validateDocument(doc).errors.join(" ")).toMatch(/low end has to be below the high end/);
  });

  it("refuses a value the parameter would reject, at authoring time", () => {
    // Checked by running it through the same `apply` the editor edits with, so a
    // range that would fail at sweep time cannot be stored in the first place.
    const doc = setDisputed(demoShape(), { ...range, min: 0 });

    expect(validateDocument(doc).errors.join(" ")).toMatch(/not usable/);
  });

  it("refuses a setting the component does not have", () => {
    const doc = setDisputed(demoShape(), { ...range, field: "retries" });

    expect(validateDocument(doc).errors.join(" ")).toMatch(/no setting called "retries"/);
  });

  it("forgets the dispute when its component goes", () => {
    const doc = removeComponent(setDisputed(demoShape(), range), "datastore-1");

    expect(doc.disputed).toBeNull();
  });
});

describe("other traffic on a shared component", () => {
  it("puts a stated rate on a component without drawing a second system", () => {
    const doc = demoShape();
    const { document, id } = addTrafficSource(doc, "datastore-1", 40);

    expect(validateDocument(document).ok).toBe(true);
    expect(document.sources).toEqual([
      { id, name: "other traffic on datastore-1", nodeId: "datastore-1", rate: 40 },
    ]);
    // No component and no wire: other traffic is a load a spine already carries,
    // not a thing on the canvas.
    expect(document.components).toEqual(doc.components);
    expect(document.edges).toEqual(doc.edges);
  });

  it("carries it through to the engine's model", () => {
    const { document } = addTrafficSource(demoShape(), "datastore-1", 40);
    expect(toTimeline(document).model.sources).toEqual(document.sources);
  });

  it("leaves the snapshot exactly as it was when there is none", () => {
    // A model with no other traffic has to project to what it projected to
    // before this existed, or every saved model gets a new answer.
    expect(toTimeline(demoShape()).model).not.toHaveProperty("sources");
  });

  it("runs, and the traffic reaches the component", () => {
    const { document } = addTrafficSource(demoShape(), "datastore-1", 40);
    const sim = createModelSimulation(toTimeline(document));
    sim.runUntil(10);

    const offered = sim
      .series()
      .reduce((total, bucket) => total + (bucket.sources["traffic-datastore-1"]?.arrivals ?? 0), 0);
    expect(offered).toBeGreaterThan(300);
  });

  it("refuses other traffic on a component that hands work on", () => {
    const { document } = addTrafficSource(demoShape(), "service-1", 40);
    expect(validateDocument(document).errors.join(" ")).toMatch(
      /hands work on to something else.*nothing is wired out of/s,
    );
  });

  it("says out loud that a cache with an origin is one of those", () => {
    // The message used to offer "a shared datastore or cache" as what other
    // traffic can land on. Every useful cache has an origin behind it, so the
    // sentence named as eligible the exact component it was about to refuse —
    // found by pointing the palette at a read-heavy architecture, where the
    // shared thing *is* a cache.
    let doc = demoShape();
    doc = addComponent(doc, { kind: "cache" }).document;
    doc = connect(doc, "balancer-1", "cache-1");
    doc = connect(doc, "cache-1", "datastore-1");

    const { document } = addTrafficSource(doc, "cache-1", 40);
    expect(validateDocument(document).errors.join(" ")).toMatch(
      /A cache with an origin behind it is wired out.*state the load on what it falls through to/s,
    );
  });

  it("refuses a negative rate, and takes a new one", () => {
    const { document, id } = addTrafficSource(demoShape(), "datastore-1", -5);
    expect(validateDocument(document).errors.join(" ")).toMatch(/runs at -5 per second/);
    expect(validateDocument(setTrafficSource(document, id, { rate: 12 })).ok).toBe(true);
  });

  it("takes the traffic away with the component it leaned on", () => {
    const { document } = addTrafficSource(demoShape(), "datastore-1", 40);
    // Left behind, it would be a stored reference to a component nobody can see.
    expect(removeComponent(document, "datastore-1").sources).toEqual([]);
  });

  it("takes it away on its own too", () => {
    const { document, id } = addTrafficSource(demoShape(), "datastore-1", 40);
    expect(removeTrafficSource(document, id).sources).toEqual([]);
  });
});

describe("the load pattern", () => {
  const errorsFor = (doc: WhiteboardDocument): string => validateDocument(doc).errors.join(" | ");

  it("reads a single step as steady and several as a schedule", () => {
    expect(loadPatternOf(demoShape()).pattern).toEqual({ kind: "steady" });
    const schedule = setLoad(demoShape(), [
      { rate: 10, duration: 30 },
      { rate: 40, duration: 5 },
    ]);
    expect(loadPatternOf(schedule)).toEqual({ base: 10, pattern: { kind: "steps", steps: schedule.load } });
  });

  it("switches to a shape around the base rate, and back", () => {
    const steady = setLoad(demoShape(), [{ rate: 25, duration: 3600 }]);
    const spiky = setPatternKind(steady, "spiky");
    expect(spiky.pattern).toEqual({ kind: "spiky", height: 3, every: 20, lasting: 2 });
    expect(spiky.load).toEqual([{ rate: 25, duration: 3600 }]);

    const back = setPatternKind(spiky, "steady");
    expect("pattern" in back).toBe(false);
    expect(back.load).toEqual([{ rate: 25, duration: 3600 }]);
  });

  it("keeps a shape's own settings when switched back to", () => {
    const mine = { kind: "random", spread: 0.2, every: 3 } as const;
    expect(setPatternKind(demoShape(), "random", mine).pattern).toEqual(mine);
  });

  it("turns a steady rate into a schedule of two equal steps", () => {
    const steps = setPatternKind(setLoad(demoShape(), [{ rate: 25, duration: 3600 }]), "steps");
    expect(steps.load).toEqual([
      { rate: 25, duration: 60 },
      { rate: 25, duration: 60 },
    ]);
  });

  it("starts a shape from a schedule's first step", () => {
    const schedule = setLoad(demoShape(), [
      { rate: 10, duration: 30 },
      { rate: 40, duration: 5 },
    ]);
    expect(setPatternKind(schedule, "spiky").load).toEqual([{ rate: 10, duration: 3600 }]);
  });

  it("runs the shape from sim time zero", () => {
    const spiky = setPattern(setLoad(demoShape(), [{ rate: 10, duration: 3600 }]), {
      kind: "spiky",
      height: 3,
      every: 20,
      lasting: 2,
    });
    expect(toTimeline(spiky).load.slice(0, 3)).toEqual([
      { rate: 10, duration: 18 },
      { rate: 30, duration: 2 },
      { rate: 10, duration: 18 },
    ]);
  });

  it("names a pattern that cannot run before Run is pressed", () => {
    const base = setLoad(demoShape(), [{ rate: 10, duration: 3600 }]);
    expect(errorsFor(setPattern(base, { kind: "formula", text: "base *" }))).toMatch(/The load pattern: .*ends too early/);
    expect(errorsFor(setPattern(base, { kind: "spiky", height: 3, every: 5, lasting: 9 }))).toMatch(/less than the gap/);
    expect(errorsFor(setPattern(base, { kind: "formula", text: "t > 10 ? 1e9 : base" }))).toMatch(/The most this page will run/);
    expect(validateDocument(setPattern(base, { kind: "formula", text: "base * 2" })).ok).toBe(true);
  });
});
