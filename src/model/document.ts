/**
 * The document: what an author is editing, and the only thing that gets saved.
 *
 * The engine's input is a `Timeline` — a model snapshot, load segments, a seed
 * and a mutation log. That is the right shape to *run* and the wrong shape to
 * *edit*: it carries a run's history, it has no notion of which preset a
 * component came from, and half of it is meaningless before anything has run.
 * So the editor owns a document, `toTimeline` projects it into what the kernel
 * reads, and nothing edits a timeline.
 *
 * Every operation returns a new document rather than mutating one. Undo is not
 * in this version, but the shape that makes undo a list of documents costs
 * nothing now and cannot be retrofitted cheaply.
 *
 * Placement is deliberately absent. Layout is derived from the wiring (see
 * `view/layout.ts`), so the editor and the run show the same picture and a saved
 * model cannot disagree with the diagram it draws. The cost is that an author
 * cannot arrange components by hand; the benefit is that there is no second
 * source of truth about where anything is, and no saved file that lays out
 * differently in a later version. Coordinates can be added later as optional
 * fields without invalidating anything saved before them.
 */
import type { EdgeKind, LoadSegment, ModelSnapshot, Timeline, TrafficSource } from "../engine/timeline.ts";
import {
  COMPONENT_KINDS,
  resolveSpec,
  validateSpec,
  type ComponentKind,
  type PartialComponentSpec,
} from "../specs/format.ts";
import { validateWiring } from "../specs/wiring.ts";
import { validateCallPolicy, type PartialCallPolicy } from "../specs/call-policy.ts";
import { fieldsFor } from "./params.ts";

export interface DocumentComponent {
  id: string;
  kind: ComponentKind;
  /** Which palette entry this came from. Display only; never interpreted. */
  preset: string | null;
  spec: PartialComponentSpec;
  /**
   * What the author picked it as — "Database", "In-memory store". Display only.
   *
   * Kept apart from `preset` because editing any field clears the preset (the
   * spec is no longer that preset's), but a database whose connection count was
   * typed by hand is still a database.
   */
  archetype?: string;
  /**
   * Where each number came from, by field key. A key that is absent is
   * **assumed**: a default or an archetype's guess that nobody has confirmed.
   *
   * The product claims correct consequences of debatable inputs, never correct
   * inputs, so which inputs are guesses is part of the model rather than a note
   * beside it.
   */
  provenance?: Record<string, Provenance>;
}

/** How much a number is known. Absent from `provenance` means assumed. */
export type Provenance = "stated" | "measured";

export interface DocumentEdge {
  from: string;
  to: string;
  /** `forward` (the default) hands work on; `call` is a dependency it waits for. */
  kind?: EdgeKind;
  /** Calls per request. Only meaningful on a `call`. */
  times?: number;
  /** The call's own timeout and retry. Only on a `call`; absent means neither. */
  policy?: PartialCallPolicy;
}

/**
 * A parameter the room does not agree on, and the range it is disputed over.
 *
 * Not an alternative way to write a number: this is the author saying "somebody
 * thinks it is 40 and somebody thinks it is 60, and I do not know which". The
 * breaking point is then swept at both ends and reported as a band, so the answer
 * carries the disagreement instead of quietly resolving it in favour of whoever
 * typed last.
 *
 * `field` is a `ParamField` key, so the range is set through the same code that
 * edits the parameter normally — a second way to write capacity onto a spec would
 * eventually disagree with the first.
 */
export interface DisputedParameter {
  componentId: string;
  field: string;
  min: number;
  max: number;
}

export interface WhiteboardDocument {
  name: string;
  components: readonly DocumentComponent[];
  edges: readonly DocumentEdge[];
  /** Where offered load enters. `null` until an author picks one. */
  entryId: string | null;
  load: readonly LoadSegment[];
  seed: string;
  /** Metrics window, sim seconds. Small values keep the live gauges moving. */
  bucketWidth: number;
  /**
   * The components that make up this month's proposal (R9).
   *
   * Marks, not a separate model. The document is the proposal; the baseline is
   * derived by taking these out. Keeping one document rather than two is what
   * makes "same load, same seed, one structural difference" true by construction
   * instead of by an author remembering to change both copies.
   *
   * Only components are marked. Which *edges* belong to the proposal follows from
   * them, and so does what the baseline's wiring has to become — see
   * `verdict/study.ts`. Deltas that are edges alone, with no new component, are
   * not expressible in this version.
   */
  delta: readonly string[];
  /** The one parameter under dispute, if any. */
  disputed: DisputedParameter | null;
  /**
   * Traffic that leans on a shared component without being part of this path.
   *
   * Drawn nowhere and wired to nothing, because it is not a system: it is the
   * load a spine already carries before this design asks anything of it. See
   * `TrafficSource` in the engine for what a source does and does not model.
   */
  sources: readonly TrafficSource[];
}

/** Live view wants gauges that move; the U4 suite sets its own. */
const LIVE_BUCKET_WIDTH = 0.25;

export function emptyDocument(name = "Untitled system"): WhiteboardDocument {
  return {
    name,
    components: [],
    edges: [],
    entryId: null,
    load: [{ rate: 20, duration: 3600 }],
    seed: "model-v1",
    bucketWidth: LIVE_BUCKET_WIDTH,
    delta: [],
    disputed: null,
    sources: [],
  };
}

/**
 * A readable, unique id for a new component of this kind.
 *
 * Names are what the diagram shows and what every error message points at, so
 * they are `datastore-2`, not a uuid. An author renaming them is a later
 * feature; a generated name nobody can read is a permanent problem.
 */
export function nextId(document: WhiteboardDocument, base: string): string {
  const taken = new Set(document.components.map((component) => component.id));
  for (let index = 1; ; index += 1) {
    const candidate = `${base}-${index}`;
    if (!taken.has(candidate)) return candidate;
  }
}

export function addComponent(
  document: WhiteboardDocument,
  component: {
    kind: ComponentKind;
    preset?: string | null;
    spec?: PartialComponentSpec;
    idBase?: string;
    archetype?: string;
  },
): { document: WhiteboardDocument; id: string } {
  // Named for what it is when the palette knows (`db-1`), for its kind otherwise.
  const id = nextId(document, component.idBase ?? component.kind);
  const added: DocumentComponent = {
    id,
    kind: component.kind,
    preset: component.preset ?? null,
    spec: component.spec ?? {},
    ...(component.archetype === undefined ? {} : { archetype: component.archetype }),
  };

  return {
    id,
    document: {
      ...document,
      components: [...document.components, added],
      // The first component becomes the entry, because a model with one
      // component and no entry admits nothing and refuses to run, which reads as
      // the editor being broken rather than as a choice not yet made.
      entryId: document.entryId ?? id,
    },
  };
}

export function removeComponent(document: WhiteboardDocument, id: string): WhiteboardDocument {
  const components = document.components.filter((component) => component.id !== id);
  return {
    ...document,
    components,
    // A mark or a disputed range pointing at something that is gone would be a
    // stored reference to nothing — the shape that turns into a crash later.
    delta: document.delta.filter((marked) => marked !== id),
    disputed: document.disputed?.componentId === id ? null : document.disputed,
    // Edges to a component that no longer exists are dangling by definition, so
    // they go with it rather than being left for validation to complain about.
    edges: document.edges.filter((edge) => edge.from !== id && edge.to !== id),
    entryId: document.entryId === id ? (components[0]?.id ?? null) : document.entryId,
    // Other traffic on a component that is gone has nothing to lean on, and a
    // stored reference to nothing is the shape that turns into a crash later.
    sources: document.sources.filter((source) => source.nodeId !== id),
  };
}

/**
 * Give a component a name of the author's choosing.
 *
 * Names are what every message and every readout points at, so `session-redis` beats
 * `store-1` — and a rename has to follow every reference, or it would leave a
 * wire, a mark or a disputed range pointing at a name that no longer exists.
 * Refused (the document comes back unchanged) for an empty name or one already
 * taken, because two components answering to one name is a model nobody can
 * read back.
 */
export function renameComponent(document: WhiteboardDocument, id: string, to: string): WhiteboardDocument {
  const name = to.trim();
  if (name === "" || name === id || document.components.some((component) => component.id === name)) return document;
  const swap = (value: string): string => (value === id ? name : value);
  return {
    ...document,
    components: document.components.map((component) => (component.id === id ? { ...component, id: name } : component)),
    edges: document.edges.map((edge) => ({ ...edge, from: swap(edge.from), to: swap(edge.to) })),
    entryId: document.entryId === null ? null : swap(document.entryId),
    delta: document.delta.map(swap),
    disputed: document.disputed === null ? null : { ...document.disputed, componentId: swap(document.disputed.componentId) },
    sources: document.sources.map((source) => ({ ...source, nodeId: swap(source.nodeId) })),
  };
}

/**
 * Change what an existing wire means: a hand-off, or something asked along the
 * way. A hand-off keeps nothing a call had — its count and its call policy belong
 * to calls — and a new call starts at once per request with no policy.
 */
export function setEdgeKind(
  document: WhiteboardDocument,
  from: string,
  to: string,
  kind: EdgeKind,
): WhiteboardDocument {
  return {
    ...document,
    edges: document.edges.map((edge) => {
      if (edge.from !== from || edge.to !== to || (edge.kind ?? "forward") === kind) return edge;
      return kind === "call" ? { from, to, kind, times: 1 } : { from, to };
    }),
  };
}

/** Mark how much a number is known. `null` puts it back to assumed. */
export function setProvenance(
  document: WhiteboardDocument,
  id: string,
  key: string,
  provenance: Provenance | null,
): WhiteboardDocument {
  return {
    ...document,
    components: document.components.map((component) => {
      if (component.id !== id) return component;
      const { [key]: _previous, ...rest } = component.provenance ?? {};
      const next = provenance === null ? rest : { ...rest, [key]: provenance };
      const { provenance: _old, ...bare } = component;
      return Object.keys(next).length === 0 ? bare : { ...bare, provenance: next };
    }),
  };
}

export function connect(
  document: WhiteboardDocument,
  from: string,
  to: string,
  kind: EdgeKind = "forward",
): WhiteboardDocument {
  const exists = document.edges.some((edge) => edge.from === from && edge.to === to);
  if (exists || from === to) return document;
  const edge: DocumentEdge = kind === "call" ? { from, to, kind, times: 1 } : { from, to };
  return { ...document, edges: [...document.edges, edge] };
}

/** How many times a request calls this dependency. */
export function setCallTimes(
  document: WhiteboardDocument,
  from: string,
  to: string,
  times: number,
): WhiteboardDocument {
  return {
    ...document,
    edges: document.edges.map((edge) =>
      edge.from === from && edge.to === to && edge.kind === "call" ? { ...edge, times } : edge,
    ),
  };
}

/**
 * How a component treats one call to a dependency: its timeout and retry.
 *
 * An empty policy removes the field rather than saving `{}`, so a call set back
 * to "never gives up, never retries" saves exactly as it did before policies.
 */
export function setCallPolicy(
  document: WhiteboardDocument,
  from: string,
  to: string,
  policy: PartialCallPolicy,
): WhiteboardDocument {
  return {
    ...document,
    edges: document.edges.map((edge) => {
      if (edge.from !== from || edge.to !== to || edge.kind !== "call") return edge;
      const { policy: _previous, ...rest } = edge;
      return Object.keys(policy).length === 0 ? rest : { ...rest, policy };
    }),
  };
}

export function disconnect(document: WhiteboardDocument, from: string, to: string): WhiteboardDocument {
  return { ...document, edges: document.edges.filter((edge) => !(edge.from === from && edge.to === to)) };
}

export function setSpec(
  document: WhiteboardDocument,
  id: string,
  spec: PartialComponentSpec,
): WhiteboardDocument {
  return {
    ...document,
    components: document.components.map((component) =>
      component.id === id ? { ...component, spec } : component,
    ),
  };
}

export function setEntry(document: WhiteboardDocument, id: string): WhiteboardDocument {
  return { ...document, entryId: id };
}

export function setLoad(document: WhiteboardDocument, load: readonly LoadSegment[]): WhiteboardDocument {
  return { ...document, load };
}

/**
 * State the traffic a shared component already carries.
 *
 * Named after the component by default, because "other traffic on orders-db" is
 * what the author would say out loud, and a name they never edit still reads.
 */
export function addTrafficSource(
  document: WhiteboardDocument,
  nodeId: string,
  rate = 0,
): { document: WhiteboardDocument; id: string } {
  const taken = new Set(document.sources.map((source) => source.id));
  let id = `traffic-${nodeId}`;
  for (let index = 2; taken.has(id); index += 1) id = `traffic-${nodeId}-${index}`;

  const source: TrafficSource = { id, name: `other traffic on ${nodeId}`, nodeId, rate };
  return { id, document: { ...document, sources: [...document.sources, source] } };
}

export function removeTrafficSource(document: WhiteboardDocument, id: string): WhiteboardDocument {
  return { ...document, sources: document.sources.filter((source) => source.id !== id) };
}

export function setTrafficSource(
  document: WhiteboardDocument,
  id: string,
  changes: Partial<Pick<TrafficSource, "name" | "rate">>,
): WhiteboardDocument {
  return {
    ...document,
    sources: document.sources.map((source) => (source.id === id ? { ...source, ...changes } : source)),
  };
}

export function setName(document: WhiteboardDocument, name: string): WhiteboardDocument {
  return { ...document, name };
}

/** Mark a component as part of the proposal, or take the mark off. */
export function setProposal(
  document: WhiteboardDocument,
  id: string,
  inProposal: boolean,
): WhiteboardDocument {
  const marked = document.delta.includes(id);
  if (marked === inProposal) return document;
  return {
    ...document,
    delta: inProposal ? [...document.delta, id] : document.delta.filter((other) => other !== id),
  };
}

export function setDisputed(
  document: WhiteboardDocument,
  disputed: DisputedParameter | null,
): WhiteboardDocument {
  return { ...document, disputed };
}

// --------------------------------------------------------------- validation

export interface DocumentValidation {
  readonly ok: boolean;
  /** One plain sentence per problem, each naming the thing at fault. */
  readonly errors: readonly string[];
}

/**
 * Everything that would make this document unrunnable, in messages an author can
 * act on.
 *
 * A refusal that says `edge "api" → "orders-db" points at "orders-db", which is
 * not in this model` is a fixable problem. A run that silently drops the edge
 * produces a confident number about a system nobody drew, which is the worst
 * outcome this tool has available.
 */
export function validateDocument(document: WhiteboardDocument): DocumentValidation {
  const errors: string[] = [];
  const ids = new Set<string>();

  for (const component of document.components) {
    if (ids.has(component.id)) errors.push(`two components are both called "${component.id}"`);
    ids.add(component.id);

    if (!(COMPONENT_KINDS as readonly string[]).includes(component.kind)) {
      errors.push(`"${component.id}" has an unknown kind "${component.kind}"`);
      continue;
    }
    const spec = validateSpec(component.kind, component.spec);
    if (!spec.ok) errors.push(`"${component.id}" has a setting this ${component.kind} cannot use: ${spec.errors[0]}`);
  }

  if (document.components.length === 0) {
    return { ok: false, errors: ["This model is empty. Add a component from the palette to start."] };
  }

  const seen = new Set<string>();
  for (const edge of document.edges) {
    if (!ids.has(edge.from)) {
      errors.push(`the wire from "${edge.from}" starts at something that is not in this model`);
    }
    if (!ids.has(edge.to)) {
      errors.push(`the wire "${edge.from}" → "${edge.to}" points at "${edge.to}", which is not in this model`);
    }
    if (edge.from === edge.to) errors.push(`"${edge.from}" is wired to itself`);
    if (edge.policy !== undefined) {
      if (edge.kind !== "call") {
        errors.push(
          `"${edge.from}" → "${edge.to}" hands work on, so its timeout and retry are "${edge.from}"'s own settings`,
        );
      } else {
        const policy = validateCallPolicy(edge.policy);
        if (!policy.ok) errors.push(`the call "${edge.from}" → "${edge.to}" has a setting it cannot use: ${policy.errors[0]}`);
      }
    }
    const key = `${edge.from} ${edge.to}`;
    if (seen.has(key)) errors.push(`"${edge.from}" → "${edge.to}" is drawn twice`);
    seen.add(key);
  }

  if (document.entryId === null) {
    errors.push("Nothing is marked as the entry point, so no load can get in. Select a component and make it the entry.");
  } else if (!ids.has(document.entryId)) {
    errors.push(`the entry point "${document.entryId}" is not in this model`);
  }

  if (document.components.length > 1) {
    const wired = new Set<string>();
    for (const edge of document.edges) {
      wired.add(edge.from);
      wired.add(edge.to);
    }
    for (const component of document.components) {
      if (!wired.has(component.id)) {
        errors.push(`"${component.id}" is not wired to anything, so nothing would ever reach it`);
      }
    }
  }

  if (document.entryId !== null && ids.has(document.entryId)) {
    const reachable = reachableFrom(document, document.entryId);
    for (const component of document.components) {
      if (!reachable.has(component.id)) {
        // Only the stranded component is quoted: every quoted name gets a problem
        // badge, and the entry point has nothing wrong with it.
        //
        // An arrow from the stranded component into the front of the system is
        // almost always one drawn the wrong way round, so it is named.
        const backwards = document.edges.find((edge) => edge.from === component.id && intoTheFront(document, reachable, edge));
        errors.push(
          backwards === undefined
            ? `Nothing sends requests to "${component.id}". They come in at ${document.entryId}, and no arrow leads from there to it`
            : `Nothing sends requests to "${component.id}". They come in at ${document.entryId}, but its arrow to ` +
                `${backwards.to} points away from it. If ${backwards.to} sends to ${component.id}, select that arrow and flip it`,
        );
      }
    }
  }

  for (const loop of closedLoops(document)) {
    errors.push(
      `${loop.join(" → ")} → ${loop[0]} is a loop with no way out, so a request that enters it never finishes. ` +
        "Wire one of these components to something outside the loop.",
    );
  }

  errors.push(...deltaErrors(document, ids));
  errors.push(...disputeErrors(document));
  errors.push(...trafficErrors(document, ids));

  document.load.forEach((segment, index) => {
    if (!Number.isFinite(segment.rate) || segment.rate < 0) {
      errors.push(`load step ${index + 1} has a rate of ${segment.rate}; it must be zero or more requests per second`);
    }
    if (!Number.isFinite(segment.duration) || segment.duration <= 0) {
      errors.push(`load step ${index + 1} lasts ${segment.duration}s; it must last longer than that`);
    }
  });
  if (document.load.length === 0) errors.push("There is no load to offer. Add at least one step.");

  // Only meaningful once the graph itself holds together; running it on a model
  // with dangling edges produces messages about consequences of a problem the
  // author has already been told about.
  if (errors.length === 0) {
    const wiring = validateWiring(toModelSnapshot(document));
    errors.push(...wiring.errors);
  }

  return { ok: errors.length === 0, errors };
}

/**
 * What other traffic is allowed to lean on.
 *
 * The leaf rule, in the author's words. A source states that a component already
 * carries load this design did not put there; it does not state what that load
 * goes on to do, because this model knows what the component does for *this*
 * path and nothing about the other product's. So other traffic can only land on
 * a component nothing is wired out of — the shared spines it exists for — and a
 * component that hands work on is refused rather than guessed at.
 */
function trafficErrors(document: WhiteboardDocument, ids: ReadonlySet<string>): string[] {
  const errors: string[] = [];
  const seen = new Set<string>();
  const wiredOut = new Set(document.edges.map((edge) => edge.from));

  for (const source of document.sources) {
    if (seen.has(source.id)) errors.push(`two lots of other traffic are both called "${source.id}"`);
    seen.add(source.id);

    if (!ids.has(source.nodeId)) {
      errors.push(`"${source.name}" lands on "${source.nodeId}", which is not in this model`);
      continue;
    }
    if (wiredOut.has(source.nodeId)) {
      errors.push(
        `"${source.name}" lands on "${source.nodeId}", which hands work on to something else. ` +
          "Other traffic can only be put on a component nothing is wired out of, because this model " +
          "knows what that component does for this path, not what the other traffic asks of it. " +
          "A cache with an origin behind it is wired out, so it cannot carry other traffic either — " +
          "state the load on what it falls through to instead.",
      );
    }
    if (!Number.isFinite(source.rate) || source.rate < 0) {
      errors.push(
        `"${source.name}" runs at ${source.rate} per second; it has to be zero or more requests per second`,
      );
    }
  }

  return errors;
}

/**
 * What makes a proposal comparable to a baseline.
 *
 * Both of these refuse a mark that would leave nothing to compare against, and
 * both are worth refusing in the editor rather than at sweep time: an author who
 * has marked their whole model has made a mistake about what the feature is for,
 * and finding that out when the verdict panel produces one arm instead of two is
 * finding it out too late to know why.
 */
function deltaErrors(document: WhiteboardDocument, ids: ReadonlySet<string>): string[] {
  const errors: string[] = [];

  for (const id of document.delta) {
    if (!ids.has(id)) errors.push(`"${id}" is marked as part of the proposal but is not in this model`);
  }

  if (document.entryId !== null && document.delta.includes(document.entryId)) {
    errors.push(
      `"${document.entryId}" is the entry point, so it cannot be part of the proposal — ` +
        "the baseline would have nothing to admit load. Mark what the proposal adds behind it instead.",
    );
  }

  if (document.components.length > 0 && document.delta.length === document.components.length) {
    errors.push(
      "Every component is marked as the proposal, so there is no baseline left to compare against. " +
        "Mark only what this month's proposal adds.",
    );
  }

  return errors;
}

/**
 * A disputed range has to be a range, and it has to be one this parameter can
 * actually take — checked by running it through the same `apply` the editor uses,
 * so a range that would fail at sweep time cannot be stored.
 */
function disputeErrors(document: WhiteboardDocument): string[] {
  const { disputed } = document;
  if (disputed === null) return [];

  const component = document.components.find((candidate) => candidate.id === disputed.componentId);
  if (component === undefined) {
    return [`the disputed parameter is on "${disputed.componentId}", which is not in this model`];
  }

  const field = fieldsFor(component.kind).find((candidate) => candidate.key === disputed.field);
  if (field === undefined) {
    return [`"${component.id}" has no setting called "${disputed.field}" to dispute`];
  }

  const errors: string[] = [];
  if (!Number.isFinite(disputed.min) || !Number.isFinite(disputed.max)) {
    errors.push(`the disputed range for ${field.label.toLowerCase()} on "${component.id}" is not a pair of numbers`);
    return errors;
  }
  if (!(disputed.min < disputed.max)) {
    errors.push(
      `the disputed range for ${field.label.toLowerCase()} on "${component.id}" is ${disputed.min} to ` +
        `${disputed.max}; the low end has to be below the high end`,
    );
  }

  for (const [end, value] of [["low", disputed.min], ["high", disputed.max]] as const) {
    const applied = field.apply(component.spec, String(value));
    if (!applied.ok) {
      errors.push(`the ${end} end of the disputed ${field.label.toLowerCase()} on "${component.id}" is not usable: ${applied.error}`);
    }
  }

  return errors;
}

/**
 * True when an arrow looks drawn the wrong way round: it runs from something
 * requests never reach into the front of the system — the entry point, or a
 * balancer requests do reach.
 *
 * Only the front, because a stranded component's other arrows are usually
 * right. An app server nothing reaches yet still rightly calls its database;
 * what is wrong is its arrow *to* the balancer that should be sending to it.
 */
export function pointsBackwards(document: WhiteboardDocument, from: string, to: string): boolean {
  if (document.entryId === null) return false;
  const reachable = reachableFrom(document, document.entryId);
  return !reachable.has(from) && intoTheFront(document, reachable, { from, to });
}

function intoTheFront(document: WhiteboardDocument, reachable: Set<string>, edge: { from: string; to: string }): boolean {
  if (!reachable.has(edge.to)) return false;
  if (edge.to === document.entryId) return true;
  return document.components.find((component) => component.id === edge.to)?.kind === "balancer";
}

function reachableFrom(document: WhiteboardDocument, start: string): Set<string> {
  const onward = new Map<string, string[]>();
  for (const component of document.components) onward.set(component.id, []);
  for (const edge of document.edges) onward.get(edge.from)?.push(edge.to);

  const seen = new Set<string>([start]);
  const queue = [start];
  while (queue.length > 0) {
    const id = queue.shift() as string;
    for (const next of onward.get(id) ?? []) {
      if (seen.has(next)) continue;
      seen.add(next);
      queue.push(next);
    }
  }
  return seen;
}

/**
 * Loops nothing can leave.
 *
 * A cycle on its own is a legal thing to draw — a service calling something that
 * calls back is a real architecture, and the layout settles it deliberately. A
 * cycle *with no edge leaving it* is different: measured against the kernel, a
 * request entering one never completes and in-flight work climbs without bound.
 * It runs, which is what makes it dangerous — the author would get a picture
 * with rising numbers and no explanation rather than an error.
 *
 * So the test is escape, not circularity: if any component in the loop is wired
 * to something outside it, traffic can get out and the model is allowed.
 */
function closedLoops(document: WhiteboardDocument): string[][] {
  const onward = new Map<string, string[]>();
  for (const component of document.components) onward.set(component.id, []);
  for (const edge of document.edges) onward.get(edge.from)?.push(edge.to);

  const loops: string[][] = [];
  const reported = new Set<string>();

  for (const component of document.components) {
    // Every component reachable from here that can also come back here is in a
    // loop with it.
    const forward = reachableFrom(document, component.id);
    const loop = [...forward].filter(
      (id) => id !== component.id && reachableFrom(document, id).has(component.id),
    );
    if (loop.length === 0) continue;

    const members = new Set([component.id, ...loop]);
    const escapes = [...members].some((id) => (onward.get(id) ?? []).some((next) => !members.has(next)));
    if (escapes) continue;

    const key = [...members].sort().join(" ");
    if (reported.has(key)) continue;
    reported.add(key);
    loops.push([...members]);
  }

  return loops;
}

// --------------------------------------------------------------- projection

function toModelSnapshot(document: WhiteboardDocument): ModelSnapshot {
  return {
    entryId: document.entryId,
    nodes: document.components.map((component) => ({
      id: component.id,
      kind: component.kind,
      spec: component.spec as Record<string, unknown>,
    })),
    edges: document.edges.map((edge) => ({
      from: edge.from,
      to: edge.to,
      ...(edge.kind === undefined ? {} : { kind: edge.kind }),
      ...(edge.times === undefined ? {} : { times: edge.times }),
      ...(edge.policy === undefined ? {} : { policy: edge.policy as Record<string, unknown> }),
    })),
    // Omitted entirely when there is none, so a model with no other traffic
    // projects to exactly the snapshot it projected to before this existed.
    ...(document.sources.length === 0 ? {} : { sources: document.sources.map((source) => ({ ...source })) }),
  };
}

/**
 * The document as the engine's input.
 *
 * A fresh run every time: no mutations, because a document has no history — the
 * live tweaks belong to the run that recorded them, and carrying them back into
 * the editor would make "what this design does" depend on how somebody drove it
 * last time.
 */
export function toTimeline(document: WhiteboardDocument): Timeline {
  return {
    model: toModelSnapshot(document),
    load: [...document.load],
    seed: document.seed,
    mutations: [],
    bucketWidth: document.bucketWidth,
  };
}

/** A component's spec with every concern filled in, for the parameter panel. */
export function resolvedSpec(component: DocumentComponent): ReturnType<typeof resolveSpec> {
  return resolveSpec(component.kind, component.spec);
}
