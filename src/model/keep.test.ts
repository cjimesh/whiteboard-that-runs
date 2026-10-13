import { describe, expect, it } from "vitest";
import { addComponent, addTrafficSource, connect, emptyDocument, setLoad, type WhiteboardDocument } from "./document.ts";
import { keepRunChanges, type RunChanges } from "./keep.ts";
import { callKey } from "../engine/timeline.ts";

function model(): WhiteboardDocument {
  let doc = emptyDocument("orders");
  doc = addComponent(doc, { kind: "balancer" }).document;
  doc = addComponent(doc, { kind: "service", spec: { concurrency: 4 } }).document;
  doc = addComponent(doc, { kind: "datastore", preset: "datastore/single-connection", spec: { concurrency: 1 } }).document;
  doc = connect(doc, "balancer-1", "service-1");
  doc = connect(doc, "service-1", "datastore-1");
  doc = { ...doc, edges: doc.edges.map((edge) => (edge.to === "datastore-1" ? { ...edge, kind: "call" as const } : edge)) };
  doc = addTrafficSource(doc, "datastore-1").document;
  return setLoad(doc, [{ rate: 20, duration: 600 }]);
}

/** What the run surface would report if nothing had been touched. */
function untouched(doc: WhiteboardDocument): RunChanges {
  return {
    specs: new Map(doc.components.map((component) => [component.id, component.spec])),
    calls: new Map(
      doc.edges.filter((edge) => edge.kind === "call").map((edge) => [callKey(edge.from, edge.to), edge.policy ?? {}]),
    ),
    sources: new Map(doc.sources.map((source) => [source.id, source.rate])),
    load: { base: doc.load[0]?.rate ?? 0, pattern: { kind: "steady" } },
  };
}

describe("keeping a run's changes", () => {
  it("returns the model itself when nothing changed", () => {
    const doc = model();
    expect(keepRunChanges(doc, untouched(doc))).toBe(doc);
  });

  it("writes a steered component back as set by hand, its moved number stated", () => {
    const doc = model();
    const changes = untouched(doc);
    const kept = keepRunChanges(doc, {
      ...changes,
      specs: new Map([...changes.specs, ["datastore-1", { concurrency: 3 }]]),
    });
    const db = kept.components.find((component) => component.id === "datastore-1");
    expect(db?.spec).toEqual({ concurrency: 3 });
    expect(db?.preset).toBeNull();
    expect(db?.provenance).toEqual({ concurrency: "stated" });
    // The component nobody touched keeps what it had.
    expect(kept.components.find((component) => component.id === "service-1")).toEqual(
      doc.components.find((component) => component.id === "service-1"),
    );
  });

  it("keeps a call's policy and other traffic's rate", () => {
    const doc = model();
    const changes = untouched(doc);
    const sourceId = doc.sources[0]?.id as string;
    const policy = { timeout: { policy: "fixed", after: 0.1 } } as const;
    const kept = keepRunChanges(doc, {
      ...changes,
      calls: new Map([[callKey("service-1", "datastore-1"), policy]]),
      sources: new Map([[sourceId, 35]]),
    });
    expect(kept.edges.find((edge) => edge.to === "datastore-1")?.policy).toEqual(policy);
    expect(kept.sources[0]?.rate).toBe(35);
  });

  it("keeps the slider's rate on a steady load, and the duration it had", () => {
    const doc = model();
    const kept = keepRunChanges(doc, { ...untouched(doc), load: { base: 44, pattern: { kind: "steady" } } });
    expect(kept.load).toEqual([{ rate: 44, duration: 600 }]);
  });

  it("keeps a pattern picked during the run", () => {
    const doc = model();
    const spiky = { kind: "spiky", height: 4, every: 30, lasting: 3 } as const;
    const kept = keepRunChanges(doc, { ...untouched(doc), load: { base: 25, pattern: spiky } });
    expect(kept.load).toEqual([{ rate: 25, duration: 3600 }]);
    expect(kept.pattern).toEqual(spiky);
  });

  it("keeps a schedule of steps as scaled by the slider", () => {
    const steps = [
      { rate: 10, duration: 30 },
      { rate: 40, duration: 5 },
    ];
    const doc = setLoad(model(), steps);
    const kept = keepRunChanges(doc, { ...untouched(doc), load: { base: 15, pattern: { kind: "steps", steps } } });
    expect(kept.load).toEqual([
      { rate: 15, duration: 30 },
      { rate: 60, duration: 5 },
    ]);
  });

  it("drops a saved pattern when the run went back to steady", () => {
    const doc = { ...model(), pattern: { kind: "random", spread: 0.5, every: 5 } as const };
    const kept = keepRunChanges(doc, { ...untouched(doc), load: { base: 20, pattern: { kind: "steady" } } });
    expect("pattern" in kept).toBe(false);
  });
});
