/**
 * "Keep these changes": the run surface's settings, written back into the model.
 *
 * A run starts from the model, and every knob turned on the run surface lives in
 * that run's log and nowhere else (see `toTimeline`). That is deliberate: most
 * live changes are experiments, and a model that absorbed each one would describe
 * whatever the driver clicked last. When the room agrees a change *is* the
 * design, the driver says so, and this copies the run's current settings into
 * the document as if they had been typed in the editor.
 *
 * Only what differs from the model is written. A component nobody touched keeps
 * its preset and its provenance; one that was steered is set by hand from now on,
 * and every number that moved is marked as stated, the same as typing it.
 */
import type { PartialComponentSpec } from "../specs/format.ts";
import type { PartialCallPolicy } from "../specs/call-policy.ts";
import { callKey } from "../engine/timeline.ts";
import { fieldsFor, tierOf } from "./params.ts";
import { stepsReference, type LoadPattern } from "./load-pattern.ts";
import {
  loadPatternOf,
  setCallPolicy,
  setProvenance,
  setTrafficSource,
  type WhiteboardDocument,
} from "./document.ts";

/** Everything the run surface can change, as it stands now. */
export interface RunChanges {
  /** Each component's spec, keyed by id. */
  specs: ReadonlyMap<string, PartialComponentSpec>;
  /** Each dependency call's policy, keyed by `callKey(from, to)`. */
  calls: ReadonlyMap<string, PartialCallPolicy>;
  /** Each other-traffic source's rate, keyed by source id. */
  sources: ReadonlyMap<string, number>;
  /** The slider's rate and the pattern around it. */
  load: { base: number; pattern: LoadPattern };
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

export function keepRunChanges(document: WhiteboardDocument, changes: RunChanges): WhiteboardDocument {
  let next = document;

  for (const component of document.components) {
    const spec = changes.specs.get(component.id);
    if (spec === undefined || same(spec, component.spec)) continue;
    next = {
      ...next,
      components: next.components.map((candidate) =>
        candidate.id === component.id ? { ...candidate, preset: null, spec } : candidate,
      ),
    };
    for (const field of fieldsFor(component.kind)) {
      if (field.control === "select" || tierOf(field, spec) === "readout") continue;
      if (field.value(spec) !== field.value(component.spec)) {
        next = setProvenance(next, component.id, field.key, "stated");
      }
    }
  }

  for (const edge of document.edges) {
    if (edge.kind !== "call") continue;
    const policy = changes.calls.get(callKey(edge.from, edge.to));
    if (policy === undefined || same(policy, edge.policy ?? {})) continue;
    next = setCallPolicy(next, edge.from, edge.to, policy);
  }

  for (const source of document.sources) {
    const rate = changes.sources.get(source.id);
    if (rate !== undefined && rate !== source.rate) next = setTrafficSource(next, source.id, { rate });
  }

  return withLoad(next, changes.load);
}

/** The run's load, in the form the model stores it; untouched if it did not change. */
function withLoad(document: WhiteboardDocument, load: RunChanges["load"]): WhiteboardDocument {
  if (same(loadPatternOf(document), load)) return document;
  const { pattern: _previous, ...rest } = document;
  const { base, pattern } = load;

  switch (pattern.kind) {
    case "steady": {
      // A steady model keeps the duration it was given; anything else runs the hour.
      const duration = document.pattern === undefined && document.load.length === 1 ? document.load[0]?.duration : 3600;
      return { ...rest, load: [{ rate: base, duration: duration ?? 3600 }] };
    }
    case "steps": {
      // The slider scales the schedule, so the schedule kept is the scaled one.
      const reference = stepsReference(pattern.steps);
      const scale = reference > 0 ? base / reference : 1;
      return {
        ...rest,
        load: pattern.steps.map((step) => ({ rate: Number((step.rate * scale).toFixed(4)), duration: step.duration })),
      };
    }
    default:
      return { ...rest, load: [{ rate: base, duration: 3600 }], pattern };
  }
}
