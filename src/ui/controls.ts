/**
 * What the run surface offers to steer, for any model — authored or built in.
 *
 * These types used to live in `demo.ts`, where they were fine while one
 * hardcoded system was the only thing that ran. The editor makes that false: a
 * model somebody drew this morning needs the same live knobs the demo has, and
 * nothing about "the capacity of a datastore" is demo-specific.
 *
 * Derived, not authored. An author who adds a datastore should not also have to
 * declare that its capacity is worth a knob — the component's own concerns
 * (`CONCERNS`) already say which parameters it reads, and every parameter that
 * can be changed live is offered.
 */
import { CONCERNS, type ComponentKind } from "../specs/format.ts";
import type { PartialComponentSpec } from "../specs/format.ts";
import { loadPatternOf, type WhiteboardDocument } from "../model/document.ts";
import { sliderMaxFor, type LoadPattern } from "../model/load-pattern.ts";

export interface PresetOption {
  value: string;
  label: string;
  /** What this choice does, shown next to the control. */
  note: string;
  /**
   * Only the concerns this choice governs.
   *
   * A control owns one decision. The retry control sends `retry` and nothing
   * else, so it cannot quietly revert a capacity somebody typed — the surface
   * merges each patch into the node's current spec before recording it.
   */
  spec: PartialComponentSpec;
}

export interface PresetControl {
  nodeIds: string[];
  label: string;
  initial: string;
  options: PresetOption[];
}

/** A component's capacity, stated in the units a reviewer speaks (R1). */
export interface CapacityControl {
  nodeIds: string[];
  kind: ComponentKind;
  label: string;
  note: string;
}

/** How long a component waits on a downstream call before giving up (R1). */
export interface TimeoutControl {
  nodeIds: string[];
  kind: ComponentKind;
  label: string;
  note: string;
}

/**
 * Traffic somebody else's system is putting on a shared component (R1).
 *
 * Live for the same reason capacity is: "what if the batch job weren't running"
 * is a question a room asks about a spine, and answering it by editing the model
 * and starting again loses the state that made the question interesting.
 */
export interface TrafficControl {
  sourceId: string;
  nodeId: string;
  label: string;
  note: string;
  base: number;
}

/**
 * A dependency call's timeout and retry, live.
 *
 * Offered only for calls whose policy somebody authored. A call nobody gave a
 * timeout or a retry has nothing to turn down, and a model with five dependency
 * calls would otherwise put ten fields in front of a room for the one question
 * worth asking. Giving a call a policy in the first place is an editor decision.
 */
export interface CallControl {
  from: string;
  to: string;
  label: string;
  note: string;
}

export interface RunControls {
  /** `pattern` is the load's shape to start on; absent means steady. */
  load: { min: number; max: number; base: number; step: number; pattern?: LoadPattern };
  presets: PresetControl[];
  capacities: CapacityControl[];
  timeouts: TimeoutControl[];
  traffic: TrafficControl[];
  calls: CallControl[];
}

/**
 * Live controls for a model somebody drew.
 *
 * The load slider's range is built around the load they composed rather than a
 * fixed scale: a model offered 20/s and one offered 8000/s both need the
 * interesting region under the thumb, and a slider that spends 95% of its travel
 * somewhere irrelevant is a slider nobody can drive in front of a room.
 */
export function controlsForDocument(document: WhiteboardDocument): RunControls {
  const { base: modelBase, pattern } = loadPatternOf(document);
  const base = document.load.length > 0 ? modelBase : 20;
  const max = sliderMaxFor(document.load.length > 0 ? document.load : [{ rate: base, duration: 1 }]);

  const capacities: CapacityControl[] = [];
  const timeouts: TimeoutControl[] = [];

  for (const component of document.components) {
    const reads = CONCERNS[component.kind];
    if (reads.includes("service")) {
      capacities.push({
        nodeIds: [component.id],
        kind: component.kind,
        label: `${component.id} capacity`,
        note: "What it can sustain. Throughput on the gauge sits below this whenever anything is queueing.",
      });
    }
    if (reads.includes("timeout")) {
      timeouts.push({
        nodeIds: [component.id],
        kind: component.kind,
        label: `${component.id} timeout`,
        note: "How long it waits before giving up and retrying. Short timeouts turn slow answers into extra load.",
      });
    }
  }

  const traffic: TrafficControl[] = document.sources.map((source) => ({
    sourceId: source.id,
    nodeId: source.nodeId,
    label: `${source.nodeId} other traffic`,
    note: `${source.name}. It takes up room on ${source.nodeId} and goes no further. Turn it to 0 to ask what this design does with the spine to itself.`,
    base: source.rate,
  }));

  const calls: CallControl[] = document.edges
    .filter((edge) => edge.kind === "call" && edge.policy !== undefined)
    .map((edge) => ({
      from: edge.from,
      to: edge.to,
      label: `${edge.from} ⇢ ${edge.to}`,
      note: "Every retry is another request on the dependency, and the attempt given up on is still there. Retries are what turn a slow spine into a full one.",
    }));

  return {
    load: { min: 1, max, base: Math.min(base, max), step: 1, ...(pattern.kind === "steady" ? {} : { pattern }) },
    // Presets belong to the editor, where a behaviour is chosen. Offering them
    // again here would be a second way to set the same thing, and the two would
    // disagree the moment a parameter was typed by hand.
    presets: [],
    capacities,
    timeouts,
    traffic,
    calls,
  };
}
