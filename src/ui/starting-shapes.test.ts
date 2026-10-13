// @vitest-environment node
/**
 * The shapes the editor offers to start from.
 *
 * A starting shape is the first thing a new author runs, so the claim is simple
 * and absolute: every one of them is a valid model, it runs, and at the load it
 * starts with it is coping — a shape that opened already folding would teach the
 * wrong first lesson about the tool.
 */
import { describe, expect, it } from "vitest";
import { STARTING_SHAPES } from "./starting-shapes.ts";
import { toTimeline, validateDocument } from "../model/document.ts";
import { createModelSimulation } from "../specs/registry.ts";
import { ARCHETYPES } from "../model/archetypes.ts";
import { presets } from "../specs/registry.ts";

describe("starting shapes", () => {
  for (const shape of STARTING_SHAPES.filter((candidate) => candidate.id !== "blank" && candidate.id !== "demo")) {
    it(`"${shape.label}" is valid, runs, and copes at the load it starts with`, () => {
      const document = shape.build();
      expect(validateDocument(document).errors).toEqual([]);

      const sim = createModelSimulation({ ...toTimeline(document), bucketWidth: 1 });
      sim.runUntil(60);
      const window = sim.series().filter((bucket) => bucket.start >= 20);
      const offered = window.reduce((total, bucket) => total + bucket.system.arrivals, 0);
      const completed = window.reduce((total, bucket) => total + bucket.system.completions, 0);

      expect(completed / offered).toBeGreaterThan(0.97);
    });
  }

  it("offers a blank canvas too", () => {
    expect(STARTING_SHAPES.find((shape) => shape.id === "blank")?.build().components).toEqual([]);
  });
});

describe("archetypes", () => {
  it("each start from a preset of their own kind", () => {
    for (const archetype of ARCHETYPES) {
      expect(presets.get(archetype.preset).kind, archetype.id).toBe(archetype.kind);
    }
  });
});
