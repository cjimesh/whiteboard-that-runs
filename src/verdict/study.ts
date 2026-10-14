/**
 * Comparison: the same question asked of two designs, or at both ends of a
 * number nobody agrees on.
 *
 * A single breaking point settles less than it looks. The arguments this tool
 * exists for are comparative — "does the cache actually buy us anything" (R9) and
 * "you are assuming the database does 50 a second and I think it does 40" (R10) —
 * and both are answered by sweeping more than once and putting the results next
 * to each other.
 *
 * Every arm runs on **the same seed**. That is what makes the comparison a
 * comparison: the arrivals are the same arrivals, so the difference between two
 * brackets is the difference between the designs and not the difference between
 * two rolls of the dice.
 *
 * ## The baseline is derived, not stored
 *
 * An author marks what this month's proposal *adds*; the baseline is the document
 * with those components taken out. One document rather than two is what makes
 * "same load, same seed, one structural difference" true by construction instead
 * of by somebody remembering to change both copies.
 *
 * Taking a component out can break the wiring, and that is where the care goes —
 * see `baselineOf`.
 */
import type { ModelSnapshot } from "../engine/timeline.ts";
import type { DisputedParameter } from "../model/document.ts";
import { fieldsFor } from "../model/params.ts";
import type { ComponentKind, PartialComponentSpec } from "../specs/format.ts";
import { validateWiring } from "../specs/wiring.ts";
import { sweep, type Probe, type SweepBudget, type SweepResult, type SweepTarget } from "./sweep.ts";

export interface ComparisonSpec {
  /** Component ids that make up the proposal. Empty means there is nothing to compare. */
  delta: readonly string[];
  disputed: DisputedParameter | null;
}

export const NO_COMPARISON: ComparisonSpec = { delta: [], disputed: null };

/**
 * The baseline: this model without the proposal, still wired up.
 *
 * Deleting the marked components and their edges is most of it and is not enough.
 * A proposal that *inserts* something — a cache between a service and a
 * datastore, a queue in front of a worker — also removed the edge it was inserted
 * into, so deleting it leaves the datastore wired to nothing and the baseline
 * refuses to run. The author would read that as the feature being broken, and
 * they would be half right.
 *
 * So removal is followed by **bridging**: where a kept component could reach
 * another kept component through nothing but proposal components, that path is
 * restored as a direct edge — but only where removal actually cost that component
 * the ability to get there at all. That per-pair test is what separates the two
 * shapes a proposal takes:
 *
 * - *inserted in series* (a cache between two services and a datastore) — neither
 *   service can reach the store any more, so **both** their original edges come
 *   back. A rule that only restored connectivity for the graph as a whole would
 *   bridge one of them and leave the other a dead end.
 * - *added in parallel* (a third replica behind a balancer) — the balancer can
 *   still reach everything through the other replicas, so nothing is bridged and
 *   it does not acquire a spurious wire straight to the datastore.
 *
 * Deriving this rather than storing the pre-proposal wiring means there is no
 * second copy of the graph to fall out of date, and an author who wires the
 * proposal in and forgets to record what it replaced still gets a valid baseline.
 */
export function baselineOf(model: ModelSnapshot, delta: readonly string[]): ModelSnapshot {
  const ids = new Set(model.nodes.map((node) => node.id));
  const removed = new Set(delta.filter((id) => ids.has(id)));
  if (removed.size === 0) return model;

  if (model.entryId !== null && removed.has(model.entryId)) {
    throw new Error(
      `"${model.entryId}" is where load enters, so a baseline without it would admit nothing. ` +
        "Mark what the proposal adds behind the entry point instead.",
    );
  }

  const nodes = model.nodes.filter((node) => !removed.has(node.id));
  const kept = new Set(nodes.map((node) => node.id));
  const bridged = model.edges.filter((edge) => kept.has(edge.from) && kept.has(edge.to)).map((edge) => ({ ...edge }));

  // Bridging restores the path work *travels*, so it follows hand-offs only. A
  // dependency on a proposal component is simply a call that stops being made;
  // there is nothing to reconnect, and treating one as a link in the chain would
  // wire a caller to whatever its dependency happened to sit in front of.
  const onward = new Map<string, string[]>();
  for (const node of model.nodes) onward.set(node.id, []);
  for (const edge of model.edges) {
    if (edge.kind !== "call") onward.get(edge.from)?.push(edge.to);
  }

  /** Kept components `from` can reach through proposal components only. */
  const throughProposal = (from: string): string[] => {
    const found: string[] = [];
    const seen = new Set<string>();
    const queue = (onward.get(from) ?? []).filter((next) => removed.has(next));
    while (queue.length > 0) {
      const id = queue.shift() as string;
      if (seen.has(id)) continue;
      seen.add(id);
      for (const next of onward.get(id) ?? []) {
        if (removed.has(next)) queue.push(next);
        else if (!found.includes(next)) found.push(next);
      }
    }
    return found;
  };

  /** Can `from` still get to `to` over the wiring the baseline has so far? */
  const reaches = (from: string, to: string): boolean => {
    const next = new Map<string, string[]>();
    for (const id of kept) next.set(id, []);
    for (const edge of bridged) next.get(edge.from)?.push(edge.to);

    const seen = new Set([from]);
    const queue = [from];
    while (queue.length > 0) {
      const id = queue.shift() as string;
      for (const onwards of next.get(id) ?? []) {
        if (onwards === to) return true;
        if (seen.has(onwards)) continue;
        seen.add(onwards);
        queue.push(onwards);
      }
    }
    return false;
  };

  // Evaluated one at a time and in model order, so a component reconnected by an
  // earlier bridge does not attract a second one, and the result does not depend
  // on iteration order.
  for (const node of nodes) {
    for (const to of throughProposal(node.id)) {
      if (!reaches(node.id, to)) bridged.push({ from: node.id, to });
    }
  }

  // Spread from the model so nothing it carries besides the graph is lost on the
  // way. Other traffic used to be: the baseline was rebuilt from the graph alone,
  // so it ran without the load from outside the drawing and every proposal on a
  // shared component was compared against a quieter system than the one drawn.
  // Traffic landing on a proposal component goes with it — that component, and
  // so whatever else used it, is not there in the baseline.
  const sources = model.sources?.filter((source) => kept.has(source.nodeId));
  const baseline: ModelSnapshot = {
    ...model,
    nodes,
    edges: bridged,
    ...(sources === undefined ? {} : { sources }),
  };

  // Checked here rather than left to blow up inside the engine, because the
  // interesting part of the message is that it is the *baseline* that cannot be
  // formed — the design on screen is fine.
  const wiring = validateWiring(baseline);
  if (!wiring.ok) {
    throw new Error(`taking the proposal out leaves a model that cannot run: ${wiring.errors[0]}`);
  }

  return baseline;
}

/** The same model with one disputed parameter set to a given end of its range. */
export function withDisputedValue(
  model: ModelSnapshot,
  disputed: DisputedParameter,
  value: number,
): ModelSnapshot {
  const node = model.nodes.find((candidate) => candidate.id === disputed.componentId);
  if (node === undefined) {
    throw new Error(`the disputed parameter is on "${disputed.componentId}", which is not in this model`);
  }

  const field = fieldsFor(node.kind as ComponentKind).find((candidate) => candidate.key === disputed.field);
  if (field === undefined) {
    throw new Error(`"${node.id}" has no setting called "${disputed.field}"`);
  }

  const applied = field.apply(node.spec as PartialComponentSpec, String(value));
  if (!applied.ok) throw new Error(`${value} is not a usable ${field.noun} here: ${applied.error}`);

  return {
    ...model,
    nodes: model.nodes.map((candidate) =>
      candidate.id === node.id ? { ...candidate, spec: applied.spec as Record<string, unknown> } : candidate,
    ),
  };
}

/** How a disputed parameter is named on screen: `orders-db capacity`. */
export function disputedLabel(model: ModelSnapshot, disputed: DisputedParameter): string {
  const node = model.nodes.find((candidate) => candidate.id === disputed.componentId);
  const field =
    node === undefined
      ? undefined
      : fieldsFor(node.kind as ComponentKind).find((candidate) => candidate.key === disputed.field);
  return `${disputed.componentId} ${field?.noun ?? disputed.field}`;
}

export type ArmSide = "design" | "proposal" | "baseline";
export type ArmEnd = "low" | "high" | null;

export interface StudyArm {
  side: ArmSide;
  end: ArmEnd;
  /** What the panel calls this arm. */
  label: string;
  /** `null` when this arm could not be run; `error` says why. */
  result: SweepResult | null;
  error: string | null;
}

export interface Study {
  arms: StudyArm[];
  /** Named for the readout, e.g. `orders-db capacity`. `null` when nothing is disputed. */
  disputed: { label: string; min: number; max: number } | null;
  hasDelta: boolean;
}

export interface StudyOptions {
  budget?: SweepBudget;
  onProbe?: (arm: string, probe: Probe, index: number, maxProbes: number) => void;
}

interface ArmPlan {
  side: ArmSide;
  end: ArmEnd;
  label: string;
  model: () => ModelSnapshot;
}

function armLabel(side: ArmSide, end: ArmEnd, disputed: string | null, range: DisputedParameter | null): string {
  const which = side === "design" ? "This design" : side === "proposal" ? "Proposal" : "Baseline";
  if (end === null || range === null || disputed === null) return which;
  const value = end === "low" ? range.min : range.max;
  return `${which} · ${disputed} ${Number(value.toFixed(2))}`;
}

/**
 * Every arm the comparison calls for: one, two or four sweeps.
 *
 * Kept as a separate pure function because *which* runs happen is the part of
 * this a reader has to be able to check at a glance, and because it makes the
 * count assertable without running anything.
 */
export function armsFor(model: ModelSnapshot, comparison: ComparisonSpec): ArmPlan[] {
  const { delta, disputed } = comparison;
  const label = disputed === null ? null : disputedLabel(model, disputed);

  const sides: ArmSide[] = delta.length === 0 ? ["design"] : ["proposal", "baseline"];
  const ends: ArmEnd[] = disputed === null ? [null] : ["low", "high"];

  const plans: ArmPlan[] = [];
  for (const side of sides) {
    for (const end of ends) {
      plans.push({
        side,
        end,
        label: armLabel(side, end, label, disputed),
        model: () => {
          const structural = side === "baseline" ? baselineOf(model, delta) : model;
          if (end === null || disputed === null) return structural;
          return withDisputedValue(structural, disputed, end === "low" ? disputed.min : disputed.max);
        },
      });
    }
  }
  return plans;
}

/**
 * Run every arm and collect the brackets.
 *
 * An arm that cannot be built or swept records its reason and the others still
 * run. A comparison that refuses to say anything because one half of it failed
 * would throw away the half that worked, and the half that worked is usually the
 * design on screen.
 */
export function runStudy(target: SweepTarget, comparison: ComparisonSpec, options: StudyOptions = {}): Study {
  const plans = armsFor(target.model, comparison);
  const disputed = comparison.disputed;

  const arms: StudyArm[] = plans.map((plan) => {
    try {
      const result = sweep(
        { model: plan.model(), seed: target.seed, baseRate: target.baseRate },
        {
          ...(options.budget === undefined ? {} : { budget: options.budget }),
          onProbe: (probe, index, maxProbes) => options.onProbe?.(plan.label, probe, index, maxProbes),
        },
      );
      return { side: plan.side, end: plan.end, label: plan.label, result, error: null };
    } catch (error) {
      return {
        side: plan.side,
        end: plan.end,
        label: plan.label,
        result: null,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  });

  return {
    arms,
    disputed:
      disputed === null
        ? null
        : { label: disputedLabel(target.model, disputed), min: disputed.min, max: disputed.max },
    hasDelta: comparison.delta.length > 0,
  };
}
