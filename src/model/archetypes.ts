/**
 * What an author picks from the palette: a thing they recognise, not a kind.
 *
 * The engine has five kinds, and every one of them is a mechanism rather than a
 * thing anybody draws on a whiteboard. Nobody says "a datastore with concurrency
 * 1 and a 0.2 ms exponential service time"; they say "the in-memory store". So
 * the palette offers archetypes — named for what something *does*, never for a
 * product (a decided boundary: no vendor-branded blocks) — and each one is a kind
 * plus a preset, which is all it ever compiles to.
 *
 * Several archetypes share a kind on purpose. A connection-pooled database, a
 * single-threaded in-memory store and a session pool are all datastores to the
 * engine, and the differences between them — one connection or a hundred, a
 * slot freed with the answer or held for a minute — are exactly the differences
 * people forget to state. Picking the archetype states them.
 */
import type { ComponentKind } from "../specs/format.ts";
import { presets } from "../specs/registry.ts";
import { addComponent, type WhiteboardDocument } from "./document.ts";

export interface Archetype {
  /** Stable handle: `data-action="add:<id>"`. */
  readonly id: string;
  /** What the palette button says. */
  readonly label: string;
  readonly kind: ComponentKind;
  /** The preset it starts from. */
  readonly preset: string;
  /** Base for generated names: `app-1`, `db-2`. Short, because the canvas prints it. */
  readonly idBase: string;
  /** One line on what it is, shown on hover and in the inspector. */
  readonly blurb: string;
}

export const ARCHETYPES: readonly Archetype[] = [
  {
    id: "balancer",
    label: "Load balancer",
    kind: "balancer",
    preset: "balancer/round-robin",
    idBase: "lb",
    blurb: "Spreads requests across whatever it is connected to.",
  },
  {
    id: "app",
    label: "App server",
    kind: "service",
    preset: "service/plain",
    idBase: "app",
    blurb: "Works on a number of requests at once, and waits on whatever it calls.",
  },
  {
    id: "database",
    label: "Database",
    kind: "datastore",
    preset: "datastore/pooled",
    idBase: "db",
    blurb: "A pool of connections. Callers queue for one when they are all busy.",
  },
  {
    id: "memory-store",
    label: "In-memory store",
    kind: "datastore",
    preset: "datastore/in-memory",
    idBase: "store",
    blurb: "Single-threaded and fast: one request at a time, each well under a millisecond.",
  },
  {
    id: "cache",
    label: "Cache",
    kind: "cache",
    preset: "cache/warm",
    idBase: "cache",
    blurb: "Answers some requests itself; the rest go on to whatever is behind it.",
  },
  {
    id: "queue",
    label: "Queue + workers",
    kind: "queue",
    preset: "queue/deep-buffer",
    idBase: "queue",
    blurb: "Takes work now and hands it on later. The sender does not wait.",
  },
  {
    id: "session-pool",
    label: "Session pool",
    kind: "datastore",
    preset: "datastore/session-pool",
    idBase: "pool",
    blurb: "Lends out a slot that stays taken for the whole session, not just the request.",
  },
];

export function archetype(id: string): Archetype {
  const found = ARCHETYPES.find((candidate) => candidate.id === id);
  if (found === undefined) {
    throw new Error(`no archetype "${id}". Known: ${ARCHETYPES.map((a) => a.id).join(", ")}`);
  }
  return found;
}

/**
 * What to call a component: the archetype it was added as, or, for a model drawn
 * before archetypes existed, the one whose preset it still matches.
 */
export function archetypeOf(component: {
  kind: ComponentKind;
  preset: string | null;
  archetype?: string;
}): Archetype | null {
  return (
    ARCHETYPES.find((candidate) => candidate.id === component.archetype) ??
    ARCHETYPES.find((candidate) => candidate.kind === component.kind && candidate.preset === component.preset) ??
    null
  );
}

/** Add one, named for what it is and starting from its preset. */
export function addArchetype(
  document: WhiteboardDocument,
  id: string,
): { document: WhiteboardDocument; id: string } {
  const chosen = archetype(id);
  return addComponent(document, {
    kind: chosen.kind,
    preset: chosen.preset,
    spec: presets.get(chosen.preset).spec,
    idBase: chosen.idBase,
    archetype: chosen.id,
  });
}
