import { describe, expect, it } from "vitest";
import { createSimulation } from "./kernel.ts";
import { referenceRegistry } from "./reference-nodes.ts";
import { validateTimeline, type Timeline } from "./timeline.ts";

/**
 * The timeline is the only input the engine has (R5), which makes it the only
 * place a malformed run can enter. Every rejection here names the offender:
 * a saved model that silently skips the change it cannot apply produces a run
 * that is reproducible and wrong, which is worse than one that refuses.
 */

function timeline(overrides: Partial<Timeline> = {}): Timeline {
  return {
    model: {
      entryId: "a",
      nodes: [
        { id: "a", kind: "reference", spec: { service: { kind: "fixed", time: 0.1 } } },
        { id: "b", kind: "reference", spec: { service: { kind: "fixed", time: 0.1 } } },
      ],
      edges: [{ from: "a", to: "b" }],
    },
    load: [{ rate: 4, duration: 5 }],
    seed: "valid",
    mutations: [],
    ...overrides,
  };
}

describe("accepting a well-formed timeline", () => {
  it("reports no errors", () => {
    const result = validateTimeline(timeline());
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("accepts an empty model with no entry", () => {
    const result = validateTimeline(
      timeline({ model: { entryId: null, nodes: [], edges: [] }, load: [] }),
    );
    expect(result.errors).toEqual([]);
  });
});

describe("rejecting a malformed timeline", () => {
  it("rejects a mutation that targets a node the model does not contain", () => {
    const result = validateTimeline(
      timeline({
        mutations: [{ at: 1, kind: "set-spec", nodeId: "ghost", spec: { service: { kind: "fixed", time: 1 } } }],
      }),
    );

    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toMatch(/ghost/);
    expect(result.errors.join("\n")).toMatch(/not in the model/i);
  });

  it("rejects an edge that references an unknown node, naming it", () => {
    const result = validateTimeline(
      timeline({
        model: {
          entryId: "a",
          nodes: [{ id: "a", kind: "reference", spec: { service: { kind: "fixed", time: 0.1 } } }],
          edges: [{ from: "a", to: "nowhere" }],
        },
      }),
    );

    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toMatch(/nowhere/);
  });

  it("rejects an entry id that is not one of the nodes", () => {
    const result = validateTimeline(timeline({ model: { ...timeline().model, entryId: "missing" } }));
    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toMatch(/missing/);
  });

  it("rejects duplicate node ids", () => {
    const result = validateTimeline(
      timeline({
        model: {
          entryId: "a",
          nodes: [
            { id: "a", kind: "reference", spec: { service: { kind: "fixed", time: 0.1 } } },
            { id: "a", kind: "reference", spec: { service: { kind: "fixed", time: 0.2 } } },
          ],
          edges: [],
        },
      }),
    );

    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toMatch(/duplicate/i);
  });

  it("rejects mutations recorded out of order", () => {
    const result = validateTimeline(
      timeline({
        mutations: [
          { at: 4, kind: "set-load", segments: [{ rate: 1, duration: 1 }] },
          { at: 2, kind: "set-load", segments: [{ rate: 1, duration: 1 }] },
        ],
      }),
    );

    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toMatch(/order/i);
  });

  it("rejects negative rates and non-positive durations in load segments", () => {
    expect(validateTimeline(timeline({ load: [{ rate: -1, duration: 5 }] })).ok).toBe(false);
    expect(validateTimeline(timeline({ load: [{ rate: 1, duration: 0 }] })).ok).toBe(false);
  });

  it("rejects a structural mutation and says what to do instead", () => {
    // Structural change is edit-then-rerun in the MVP. Accepting these in the
    // timeline would put untested machinery in the one part of the system the
    // determinism claim rests on.
    const result = validateTimeline(
      timeline({
        mutations: [
          { at: 1, kind: "add-node" } as unknown as Timeline["mutations"][number],
        ],
      }),
    );

    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toMatch(/structural/i);
    expect(result.errors.join("\n")).toMatch(/rerun/i);
  });
});

describe("the kernel refuses to run an invalid timeline", () => {
  it("throws rather than silently skipping the mutation it cannot apply", () => {
    const bad = timeline({
      mutations: [{ at: 1, kind: "set-spec", nodeId: "ghost", spec: {} }],
    });

    expect(() => createSimulation(bad, referenceRegistry())).toThrow(/ghost/);
  });

  it("throws when a node kind has no registered behavior, naming the kind", () => {
    const bad = timeline({
      model: {
        entryId: "a",
        nodes: [{ id: "a", kind: "quantum-flux", spec: {} }],
        edges: [],
      },
    });

    expect(() => createSimulation(bad, referenceRegistry())).toThrow(/quantum-flux/);
  });
});
