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
import { setSpec, toTimeline, validateDocument } from "../model/document.ts";
import { sweep } from "../verdict/sweep.ts";
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

  // From outside feedback: none of the shapes has a timeout, so a slow component
  // behind a waiting app server never loses work itself — the app server's queue
  // is the one that fills. Breaking point used to name the app server.
  it("names the component that is the limit, not the app server waiting on it", () => {
    let doc = (STARTING_SHAPES.find((shape) => shape.id === "web-database") as (typeof STARTING_SHAPES)[number]).build();
    const db = doc.components.find((component) => component.id === "db-1");
    doc = setSpec(doc, "db-1", { ...db?.spec, service: { policy: "exponential", mean: 0.05 } });
    expect(sweep({ model: toTimeline(doc).model, seed: "shapes", baseRate: 100 }).firstToFold).toBe("db-1");

    const queue = (STARTING_SHAPES.find((shape) => shape.id === "queue") as (typeof STARTING_SHAPES)[number]).build();
    expect(sweep({ model: toTimeline(queue).model, seed: "shapes", baseRate: 50 }).firstToFold).toBe("queue-1");
  }, 120_000);

  // The queue archetype says "The sender does not wait", so the shape's sender
  // must not: it used to wait on the queue, the workers and the database.
  it("has the queue shape's sender hand off without waiting", () => {
    const queue = (STARTING_SHAPES.find((shape) => shape.id === "queue") as (typeof STARTING_SHAPES)[number]).build();
    const sender = queue.components.find((component) => component.id === "app-1");
    expect(sender?.spec.downstream?.policy).toBe("fire-and-forget");
    expect(sender?.preset).toBeNull();
  });

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
