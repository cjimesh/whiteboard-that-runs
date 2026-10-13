import { describe, expect, it } from "vitest";
import type { ModelSnapshot } from "../engine/timeline.ts";
import { LAYOUT_BOX, layoutModel, overlaps } from "./layout.ts";

/**
 * Layout is derived from the wiring, so it has to hold up for models nobody
 * arranged — including the twenty-component case the plan names, where the
 * failure mode is not ugliness but boxes drawn on top of each other.
 */

function model(nodes: string[], edges: Array<[string, string]>): ModelSnapshot {
  return {
    entryId: nodes[0] ?? null,
    nodes: nodes.map((id) => ({ id, kind: "service", spec: {} })),
    edges: edges.map(([from, to]) => ({ from, to })),
  };
}

describe("ranking", () => {
  it("puts flow left to right along the wiring", () => {
    const layout = layoutModel(model(["a", "b", "c"], [["a", "b"], ["b", "c"]]));
    const x = (id: string): number => layout.nodes[id]?.x ?? 0;

    expect(x("a")).toBeLessThan(x("b"));
    expect(x("b")).toBeLessThan(x("c"));
  });

  it("ranks by the longest path, so a shortcut does not pull a node forward", () => {
    // a → b → c and a → c. `c` belongs after `b`, not beside it.
    const layout = layoutModel(model(["a", "b", "c"], [["a", "b"], ["b", "c"], ["a", "c"]]));
    expect(layout.nodes["c"]?.x).toBeGreaterThan(layout.nodes["b"]?.x ?? 0);
  });

  it("stacks a fan-out in one column, centred about the middle of the canvas", () => {
    const layout = layoutModel(model(["lb", "a", "b", "c"], [["lb", "a"], ["lb", "b"], ["lb", "c"]]));
    const column = ["a", "b", "c"].map((id) => layout.nodes[id]);

    expect(new Set(column.map((place) => place?.x)).size).toBe(1);
    const centres = column.map((place) => (place?.y ?? 0) + (place?.h ?? 0) / 2);
    const middle = (centres[0] as number) + (centres[2] as number);
    expect(middle / 2).toBeCloseTo(LAYOUT_BOX.height / 2, 5);
  });

  it("settles a cycle instead of looping forever", () => {
    // A retrying service calling something that calls back is a real shape, and a
    // topological sort would either throw or silently drop an edge.
    const cyclic = model(["a", "b", "c"], [["a", "b"], ["b", "c"], ["c", "b"]]);
    expect(() => layoutModel(cyclic)).not.toThrow();
    expect(Object.keys(layoutModel(cyclic).nodes)).toHaveLength(3);
  });
});

describe("fitting the canvas", () => {
  it("never overlaps two components, even at twenty of them", () => {
    const ids = Array.from({ length: 20 }, (_, i) => `n${i}`);
    // Four ranks of five: the densest arrangement the ranking can produce here.
    const edges: Array<[string, string]> = [];
    for (let rank = 0; rank < 3; rank += 1) {
      for (let row = 0; row < 5; row += 1) {
        edges.push([`n${rank * 5 + row}`, `n${(rank + 1) * 5 + row}`]);
      }
    }

    const layout = layoutModel(model(ids, edges));
    const places = ids.map((id) => layout.nodes[id]).filter((place) => place !== undefined);
    expect(places).toHaveLength(20);

    for (let i = 0; i < places.length; i += 1) {
      for (let j = i + 1; j < places.length; j += 1) {
        expect(overlaps(places[i]!, places[j]!), `${ids[i]} overlaps ${ids[j]}`).toBe(false);
      }
    }
  });

  it("keeps every component inside the canvas", () => {
    const ids = Array.from({ length: 12 }, (_, i) => `n${i}`);
    const layout = layoutModel(model(ids, ids.slice(1).map((id, i) => [`n${i}`, id] as [string, string])));

    for (const id of ids) {
      const place = layout.nodes[id];
      expect(place).toBeDefined();
      expect(place!.x).toBeGreaterThanOrEqual(0);
      expect(place!.y).toBeGreaterThanOrEqual(0);
      expect(place!.x + place!.w).toBeLessThanOrEqual(LAYOUT_BOX.width);
      expect(place!.y + place!.h).toBeLessThanOrEqual(LAYOUT_BOX.height);
    }
  });

  it("shrinks components as a column fills rather than letting them collide", () => {
    const wide = layoutModel(model(["lb", ...Array.from({ length: 8 }, (_, i) => `n${i}`)],
      Array.from({ length: 8 }, (_, i) => ["lb", `n${i}`] as [string, string])));
    const narrow = layoutModel(model(["lb", "n0"], [["lb", "n0"]]));

    expect(wide.nodes["n0"]!.h).toBeLessThan(narrow.nodes["n0"]!.h);
  });

  it("handles an empty model and a single component", () => {
    expect(layoutModel({ entryId: null, nodes: [], edges: [] }).nodes).toEqual({});
    const single = layoutModel(model(["only"], []));
    expect(single.nodes["only"]?.w).toBeGreaterThan(0);
  });

  it("is deterministic for the same model", () => {
    const m = model(["a", "b", "c"], [["a", "b"], ["a", "c"]]);
    expect(JSON.stringify(layoutModel(m))).toBe(JSON.stringify(layoutModel(m)));
  });
});

describe("filling the canvas", () => {
  const bounds = (layout: ReturnType<typeof layoutModel>) => {
    const places = Object.values(layout.nodes);
    return {
      width: Math.max(...places.map((p) => p.x + p.w)) - Math.min(...places.map((p) => p.x)),
      height: Math.max(...places.map((p) => p.y + p.h)) - Math.min(...places.map((p) => p.y)),
    };
  };

  it("grows a small model rather than leaving it adrift in the middle", () => {
    // The demo's shape: a balancer, two replicas, one datastore. Capped node
    // sizes left this filling barely half the canvas, which reads as a small
    // picture however large the canvas is.
    const layout = layoutModel(
      model(["lb", "a", "b", "db"], [["lb", "a"], ["lb", "b"], ["a", "db"], ["b", "db"]]),
    );

    expect(bounds(layout).height).toBeGreaterThan(LAYOUT_BOX.height * 0.55);
  });

  it("keeps everything inside the canvas it was given", () => {
    const layout = layoutModel(model(["a", "b"], [["a", "b"]]));

    for (const place of Object.values(layout.nodes)) {
      expect(place.x).toBeGreaterThanOrEqual(0);
      expect(place.y).toBeGreaterThanOrEqual(0);
      expect(place.x + place.w).toBeLessThanOrEqual(LAYOUT_BOX.width);
      expect(place.y + place.h).toBeLessThanOrEqual(LAYOUT_BOX.height);
    }
  });

  it("still draws no boxes on top of each other after growing", () => {
    const ids = Array.from({ length: 20 }, (_, i) => `n${i}`);
    const edges = ids.slice(1).map((id, i) => [ids[i] as string, id] as [string, string]);
    const wide = layoutModel(model(["lb", ...ids], ids.map((id) => ["lb", id] as [string, string])));
    const deep = layoutModel(model(ids, edges));

    for (const layout of [wide, deep]) {
      const places = Object.values(layout.nodes);
      for (let i = 0; i < places.length; i += 1) {
        for (let j = i + 1; j < places.length; j += 1) {
          expect(overlaps(places[i]!, places[j]!)).toBe(false);
        }
      }
    }
  });

  it("leaves a model that already fills its canvas alone", () => {
    const ids = Array.from({ length: 8 }, (_, i) => `n${i}`);
    const layout = layoutModel(model(["lb", ...ids], ids.map((id) => ["lb", id] as [string, string])));
    // Eight in a column already reaches the margins; growing it would push it out.
    expect(bounds(layout).height).toBeLessThanOrEqual(LAYOUT_BOX.height - 2 * 56 + 1);
  });
});
