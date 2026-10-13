/**
 * Wiring rules that follow from what the components can actually do.
 *
 * The original rule exists because of a real hazard: every component except the
 * balancer hands work on to *one* place, so a service drawn with two outgoing
 * edges would quietly use the first and ignore the second. The canvas would show
 * a fan-out and the numbers would describe something else — a model that
 * disagrees with the picture the room is looking at, which is the single worst
 * failure mode available to this tool.
 *
 * That rule now applies to **forward** edges only, and the narrowing is the
 * point. Drawing a real system showed that the rule was policing two different
 * things at once: where work goes next, which genuinely is one place, and what a
 * component *leans on*, which is routinely several. A store called by several
 * components was not a fan-out and could not be drawn at all. Dependencies are
 * `call` edges and there may be as many as the component really has.
 *
 * Fan-out with a join — several successors, waiting for all of them — is still
 * refused, and is still real scope this version does not have.
 *
 * The broader wiring checks the plan assigns to the editor — dangling edges,
 * orphaned components, illegal cycles — belong with the editor that can point at
 * the offending edge. This file is only the part that is a consequence of
 * component semantics.
 */
import type { ModelSnapshot } from "../engine/timeline.ts";
import { COMPONENT_KINDS, type ComponentKind } from "./format.ts";

export interface WiringValidation {
  readonly ok: boolean;
  readonly errors: readonly string[];
}

/** Kinds that may have more than one outgoing edge. */
const FANS_OUT: readonly ComponentKind[] = ["balancer"];

export function validateWiring(model: ModelSnapshot): WiringValidation {
  const errors: string[] = [];
  const forwards = new Map<string, string[]>();
  const calls = new Map<string, string[]>();
  for (const node of model.nodes) {
    forwards.set(node.id, []);
    calls.set(node.id, []);
  }
  for (const edge of model.edges) {
    if (edge.kind === "call") calls.get(edge.from)?.push(edge.to);
    else forwards.get(edge.from)?.push(edge.to);
  }

  for (const node of model.nodes) {
    if (!(COMPONENT_KINDS as readonly string[]).includes(node.kind)) continue;
    const targets = forwards.get(node.id) ?? [];
    const kind = node.kind as ComponentKind;

    if (!FANS_OUT.includes(kind) && targets.length > 1) {
      errors.push(
        `"${node.id}" is a ${kind} that hands work on to ${targets.length} places (${targets.join(", ")}), ` +
          `and a ${kind} hands work on to one. Put a load balancer in front of the fan-out, ` +
          "or make the extra ones dependencies it calls and waits for.",
      );
    }

    if (FANS_OUT.includes(kind) && targets.length === 0) {
      errors.push(`"${node.id}" is a ${kind} with nothing wired behind it, so every request it gets is refused.`);
    }

    // A balancer is a routing decision, not a server: it has no slot to hold
    // while something answers, so a dependency on one would be drawn and never
    // run. The component that actually makes the call should own it.
    if (FANS_OUT.includes(kind) && (calls.get(node.id) ?? []).length > 0) {
      errors.push(
        `"${node.id}" is a ${kind}, which routes rather than works, so it cannot call a dependency. ` +
          "Move that dependency to the component behind it.",
      );
    }

    // Calling yourself is a request waiting on a slot it is already holding.
    if ((calls.get(node.id) ?? []).includes(node.id)) {
      errors.push(`"${node.id}" depends on itself, so a request there would wait for a slot it is already holding.`);
    }
  }

  return { ok: errors.length === 0, errors };
}
