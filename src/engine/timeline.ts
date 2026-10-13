/**
 * The recorded input timeline — the engine's only input, and the determinism
 * contract in one type (R5).
 *
 * Model snapshot + load segments + seed + an ordered mutation log is everything
 * a run depends on. If a result can be reproduced from this and nothing else,
 * then a session driven live in front of a room replays exactly, which is the
 * difference between "the model shows X" and "it showed X when I ran it".
 *
 * MVP mutations are parameter and load changes only. Structural changes —
 * adding, removing or rewiring components — are edit-then-rerun with a fresh
 * timeline. That is a deliberate narrowing: mid-run structural mutation is the
 * hardest case to get deterministically right, it is not needed by any flow
 * (F2's structural challenges are answered by editing and rerunning), and
 * carrying untested machinery inside the one subsystem the whole product's
 * credibility rests on is a bad trade.
 */

export interface NodeSnapshot {
  readonly id: string;
  /** Which behavior interprets this node. Resolved through the registry. */
  readonly kind: string;
  /** Declarative behavior spec (R2). The engine never looks inside it. */
  readonly spec: Record<string, unknown>;
}

/**
 * What an edge means.
 *
 * `forward` hands the work on and is done with it — the original and still the
 * default. `call` is a synchronous dependency: the component asks something and
 * waits for the answer, holding its own slot meanwhile, then carries on.
 *
 * The distinction had to exist because without it a component could only ever be
 * *in* a chain, and the systems this tool was built for are full of things that
 * are not: a Redis, a shared primary database, a token service. Five components
 * leaning on one of those is not a shape the single-successor rule could draw,
 * and the two available workarounds — folding the dependency's latency into each
 * caller's own work, or drawing it once behind the biggest caller — each get a
 * different thing wrong. The first hides that the callers share a server and so
 * degrade together, which is the failure mode. The second understates the load on
 * the shared thing by however many callers were dropped.
 */
export type EdgeKind = "forward" | "call";

export interface EdgeSnapshot {
  readonly from: string;
  readonly to: string;
  /** Defaults to `forward`, so every model drawn before this existed still reads. */
  readonly kind?: EdgeKind;
  /**
   * How many times one request calls this dependency. Ignored on a forward.
   *
   * A parameter rather than an assumed 1 because the number is load-bearing and
   * people know it: a request that touches Redis twenty times puts twenty
   * times the traffic on it, and that is the difference between a shared spine
   * that copes and one that is the constraint.
   */
  readonly times?: number;
  /**
   * How the caller treats this call: its timeout and retry. Only on a `call`.
   *
   * Opaque here for the same reason a node's spec is — the engine carries it and
   * the component interprets it (`specs/call-policy.ts`). Absent means no timeout
   * and no retry, which is what a dependency call was before this existed.
   */
  readonly policy?: Record<string, unknown>;
}

/** The one identity a call edge has: its two ends. */
export function callKey(from: string, to: string): string {
  return JSON.stringify([from, to]);
}

/**
 * Traffic that leans on a component without being part of the modelled path.
 *
 * A shared Redis serves several products; a shared database carries
 * the reports nobody drew. With one source of arrivals the spine runs with most
 * of its real load missing, so it reads as idle and the tool names the wrong
 * component. This is the missing load, stated the way its owner knows it: a rate
 * on a component, not a second system to draw.
 *
 * Deliberately *contention, not a flow*. A request from a source occupies the
 * component's servers, queue and hold under that component's own spec, and then
 * leaves: it does not forward downstream and it does not call the component's
 * dependencies. Those onward paths belong to the other product, which nobody
 * submitted, and inventing them would put confident numbers on a system that was
 * never drawn. The cost of that choice: one other flow leaning on *two* shared
 * components is modelled here as two independent sources, so an excursion that
 * hits both at once is not expressible.
 */
export interface TrafficSource {
  readonly id: string;
  /** What this traffic is, in the author's words: "everything else on Redis". */
  readonly name: string;
  /** The component it lands on. */
  readonly nodeId: string;
  /** Requests per second, for as long as the offered load runs. */
  readonly rate: number;
}

export interface ModelSnapshot {
  readonly nodes: readonly NodeSnapshot[];
  readonly edges: readonly EdgeSnapshot[];
  /** Where offered load enters. `null` means a model that admits nothing. */
  readonly entryId: string | null;
  /** Other traffic on shared components. Absent means none. */
  readonly sources?: readonly TrafficSource[];
}

/** One stretch of offered load: `rate` requests per second, for `duration` seconds. */
export interface LoadSegment {
  readonly rate: number;
  readonly duration: number;
}

/**
 * A change an operator makes, without its timestamp.
 *
 * This is the shape the live UI produces: the operator drags a slider, and the
 * kernel stamps it with the current sim time on the way into the log. Splitting
 * the timestamp off is what keeps one path for both modes — live recording and
 * replay append the same objects to the same log, so a session driven in front
 * of a room is replayable by construction rather than by a parallel code path
 * that has to be kept honest.
 */
export type LiveMutation =
  | { readonly kind: "set-spec"; readonly nodeId: string; readonly spec: Record<string, unknown> }
  | { readonly kind: "set-load"; readonly segments: readonly LoadSegment[] }
  | { readonly kind: "set-source-rate"; readonly sourceId: string; readonly rate: number }
  | {
      readonly kind: "set-call";
      readonly from: string;
      readonly to: string;
      /** Replaces the call's policy wholesale, as `set-spec` replaces a spec. */
      readonly policy: Record<string, unknown>;
    };

export type MutationEvent = LiveMutation & { readonly at: number };

/**
 * How arrivals are generated within a load segment.
 *
 * `poisson` (the default) draws exponential interarrivals, which is what makes
 * the M/M/1 and M/M/c checks in the validation suite exact rather than
 * approximate. `deterministic` spaces arrivals evenly at 1/rate; it exists for
 * tests that need an arrival to land on a nameable instant, and for models
 * where the offered load genuinely is a metronome.
 */
export type ArrivalProcess = "poisson" | "deterministic";

export interface Timeline {
  readonly model: ModelSnapshot;
  readonly load: readonly LoadSegment[];
  readonly seed: string;
  readonly mutations: readonly MutationEvent[];
  readonly arrivalProcess?: ArrivalProcess;
  /** Width of a metrics window, in sim seconds. Default 1. */
  readonly bucketWidth?: number;
}

export interface TimelineValidation {
  readonly ok: boolean;
  readonly errors: readonly string[];
}

const STRUCTURAL_KINDS = new Set([
  "add-node",
  "remove-node",
  "add-edge",
  "remove-edge",
  "rewire",
  "set-model",
]);

function validateLoad(segments: readonly LoadSegment[], label: string, errors: string[]): void {
  segments.forEach((segment, index) => {
    if (!Number.isFinite(segment.rate) || segment.rate < 0) {
      errors.push(`${label} segment ${index}: rate must be a finite non-negative number, got ${segment.rate}`);
    }
    if (!Number.isFinite(segment.duration) || segment.duration <= 0) {
      errors.push(`${label} segment ${index}: duration must be a positive number, got ${segment.duration}`);
    }
  });
}

/**
 * Check one mutation against the model it targets.
 *
 * Split out from `validateTimeline` because the live path validates a single
 * appended mutation on every slider tick, and re-checking the whole log each
 * time would make a drag quadratic in the number of changes already recorded.
 */
export function checkMutation(
  mutation: MutationEvent,
  nodeIds: ReadonlySet<string>,
  previousAt: number,
  label: string,
  sourceIds: ReadonlySet<string> = new Set(),
  calls: ReadonlySet<string> = new Set(),
): string[] {
  const errors: string[] = [];

  if (!Number.isFinite(mutation.at) || mutation.at < 0) {
    errors.push(`${label}: "at" must be a finite non-negative sim time, got ${mutation.at}`);
  }
  if (mutation.at < previousAt) {
    errors.push(
      `${label} is recorded out of order: stamped at ${mutation.at} after ${previousAt}. ` +
        "The mutation log is append-only in sim-time order.",
    );
  }

  const kind: string = mutation.kind;
  if (STRUCTURAL_KINDS.has(kind)) {
    return [
      ...errors,
      `${label} is a structural change ("${kind}"). Structural changes are edit-then-rerun ` +
        "in this version: change the model and rerun with a fresh timeline.",
    ];
  }

  switch (mutation.kind) {
    case "set-spec":
      if (!nodeIds.has(mutation.nodeId)) {
        errors.push(`${label} targets node "${mutation.nodeId}", which is not in the model`);
      }
      break;
    case "set-load":
      validateLoad(mutation.segments, `${label} load`, errors);
      break;
    case "set-source-rate":
      if (!sourceIds.has(mutation.sourceId)) {
        errors.push(`${label} targets other traffic "${mutation.sourceId}", which is not in the model`);
      }
      if (!Number.isFinite(mutation.rate) || mutation.rate < 0) {
        errors.push(`${label}: rate must be a finite non-negative number, got ${mutation.rate}`);
      }
      break;
    case "set-call":
      if (!calls.has(callKey(mutation.from, mutation.to))) {
        errors.push(
          `${label} targets the call "${mutation.from}" → "${mutation.to}", which is not a dependency in the model`,
        );
      }
      break;
    default:
      errors.push(`${label} has an unknown kind "${kind}"`);
  }

  return errors;
}

/**
 * Check a timeline before anything runs on it.
 *
 * Every message names the offending element. A run that silently skips the one
 * mutation it could not apply is reproducible and wrong, which is strictly
 * worse than one that refuses to start — and in a review room, a refusal that
 * says "edge api → (missing) points nowhere" is a fixable problem, while a
 * quietly wrong number is an argument lost for the wrong reason.
 */
export function validateTimeline(timeline: Timeline): TimelineValidation {
  const errors: string[] = [];
  const { model } = timeline;

  const ids = new Set<string>();
  for (const node of model.nodes) {
    if (ids.has(node.id)) {
      errors.push(`duplicate node id "${node.id}"`);
    }
    ids.add(node.id);
  }

  for (const edge of model.edges) {
    if (!ids.has(edge.from)) {
      errors.push(`edge "${edge.from}" → "${edge.to}" starts at "${edge.from}", which is not in the model`);
    }
    if (!ids.has(edge.to)) {
      errors.push(`edge "${edge.from}" → "${edge.to}" ends at "${edge.to}", which is not in the model`);
    }
    if (edge.times !== undefined && !(Number.isInteger(edge.times) && edge.times >= 1)) {
      errors.push(
        `edge "${edge.from}" → "${edge.to}" is called ${edge.times} times; it must be a whole number of at least 1`,
      );
    }
    // A hand-off's timeout and retry are the sending component's own, so a
    // policy here would be a second, conflicting statement of the same thing.
    if (edge.policy !== undefined && edge.kind !== "call") {
      errors.push(
        `edge "${edge.from}" → "${edge.to}" hands work on, so it has no call policy of its own; ` +
          `"${edge.from}"'s own timeout and retry govern it`,
      );
    }
  }
  const calls = new Set(
    model.edges.filter((edge) => edge.kind === "call").map((edge) => callKey(edge.from, edge.to)),
  );

  if (model.entryId !== null && !ids.has(model.entryId)) {
    errors.push(`entry node "${model.entryId}" is not in the model`);
  }

  const wiredOut = new Set(model.edges.map((edge) => edge.from));
  const sourceIds = new Set<string>();
  for (const source of model.sources ?? []) {
    if (sourceIds.has(source.id)) {
      errors.push(`duplicate traffic source id "${source.id}"`);
    }
    sourceIds.add(source.id);
    if (!ids.has(source.nodeId)) {
      errors.push(
        `other traffic "${source.id}" lands on "${source.nodeId}", which is not in the model`,
      );
    }
    if (!Number.isFinite(source.rate) || source.rate < 0) {
      errors.push(
        `other traffic "${source.id}" has a rate of ${source.rate}; it must be zero or more per second`,
      );
    }
    // The leaf rule (see `TrafficSource`): a source's requests are charged for
    // the component they land on and nothing else, so a component that hands
    // work on would have to invent where the other product's requests go next.
    if (ids.has(source.nodeId) && wiredOut.has(source.nodeId)) {
      errors.push(
        `other traffic "${source.id}" lands on "${source.nodeId}", which hands work on to something else. ` +
          "Other traffic can only land on a component nothing is wired out of — a shared spine — " +
          "because this model knows what that component does for this path, not what the other traffic asks of it.",
      );
    }
  }

  validateLoad(timeline.load, "load", errors);

  let previousAt = Number.NEGATIVE_INFINITY;
  timeline.mutations.forEach((mutation, index) => {
    errors.push(...checkMutation(mutation, ids, previousAt, `mutation ${index}`, sourceIds, calls));
    previousAt = mutation.at;
  });

  if (timeline.bucketWidth !== undefined && !(timeline.bucketWidth > 0)) {
    errors.push(`bucketWidth must be a positive number of sim seconds, got ${timeline.bucketWidth}`);
  }

  return { ok: errors.length === 0, errors };
}

/** Total sim time the load timeline covers. Arrivals stop after it. */
export function loadDuration(segments: readonly LoadSegment[]): number {
  return segments.reduce((total, segment) => total + segment.duration, 0);
}
