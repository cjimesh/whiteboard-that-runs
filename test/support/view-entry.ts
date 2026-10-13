/**
 * Browser entry for the render test.
 *
 * Bundled into a standalone script so a real browser can be handed an arbitrary
 * model and asked to paint it. The frame model is proven pure by its own unit
 * tests; this exists to prove the other half — that the values it produces
 * actually paint, on every model shape, without throwing.
 */
import { createModelSimulation } from "../../src/specs/registry.ts";
import { frameFor } from "../../src/view/frame.ts";
import { createRenderer } from "../../src/view/renderer.ts";
import type { Timeline } from "../../src/engine/timeline.ts";

export interface RenderOutcome {
  ok: boolean;
  nodes: number;
  edges: number;
  error?: string;
}

export function renderModel(canvas: HTMLCanvasElement, timelineJson: string, seconds: number): RenderOutcome {
  try {
    const timeline = JSON.parse(timelineJson) as Timeline;
    const sim = createModelSimulation(timeline);
    sim.runUntil(seconds);

    const frame = frameFor({ model: sim.recorded().model, snapshot: sim.snapshot(), series: sim.series() });
    createRenderer(canvas).paint(frame);

    return { ok: true, nodes: frame.nodes.length, edges: frame.edges.length };
  } catch (error) {
    return { ok: false, nodes: 0, edges: 0, error: error instanceof Error ? error.message : String(error) };
  }
}
