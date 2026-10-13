/**
 * Saving and opening a model, as a file on the author's own disk.
 *
 * R4's monthly loop is the whole point: open last month's model of the existing
 * system, add this month's proposal, run both. That only works if a saved file
 * reopens as *exactly* what was saved, so the round trip is asserted rather than
 * assumed.
 *
 * A file, not local storage, and R11 is why. This page has no backend and never
 * reaches the network; a model the author cannot see, copy or mail is one this
 * tool is holding hostage in a browser profile. A JSON file can be committed
 * next to the design doc it argues about.
 *
 * **Schema, not runnability.** A saved file is allowed to be a work in progress —
 * an entry point not yet chosen, a component not yet wired — so opening it
 * restores what was saved and `validateDocument` complains about what is missing.
 * A loader that refused half-finished work would make saving something an author
 * has to earn.
 */
import type { LoadSegment, TrafficSource } from "../engine/timeline.ts";
import { SHAPED_KINDS, type ShapedPattern } from "./load-pattern.ts";
import { COMPONENT_KINDS, type ComponentKind } from "../specs/format.ts";
import type { PartialCallPolicy } from "../specs/call-policy.ts";
import type { Provenance } from "./document.ts";
import {
  emptyDocument,
  type DisputedParameter,
  type DocumentComponent,
  type DocumentEdge,
  type WhiteboardDocument,
} from "./document.ts";

/** Identifies the file as ours, so a stray JSON gets a plain message. */
export const FILE_FORMAT = "whiteboard-that-runs/model";
export const FILE_VERSION = 1;

export interface SavedFile {
  format: string;
  version: number;
  document: WhiteboardDocument;
}

export type ParseResult = { ok: true; document: WhiteboardDocument } | { ok: false; error: string };

export function serialize(document: WhiteboardDocument): string {
  const file: SavedFile = { format: FILE_FORMAT, version: FILE_VERSION, document };
  // Indented: this file lands in a repository next to the design it argues
  // about, and a one-line blob makes its diff useless.
  return `${JSON.stringify(file, null, 2)}\n`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseComponent(raw: unknown, index: number): DocumentComponent | string {
  if (!isRecord(raw)) return `component ${index + 1} is not an object`;
  const { id, kind, preset, spec, archetype, provenance } = raw;

  if (typeof id !== "string" || id === "") return `component ${index + 1} has no name`;
  if (typeof kind !== "string" || !(COMPONENT_KINDS as readonly string[]).includes(kind)) {
    return `"${id}" has an unknown kind "${String(kind)}". This file may come from a newer version.`;
  }
  if (spec !== undefined && !isRecord(spec)) return `"${id}" has settings that are not an object`;

  return {
    id,
    kind: kind as ComponentKind,
    preset: typeof preset === "string" ? preset : null,
    spec: isRecord(spec) ? (spec as DocumentComponent["spec"]) : {},
    // Both display-only and both newer than version 1: a file without them reads
    // as a component of no particular archetype whose every number is assumed.
    ...(typeof archetype === "string" ? { archetype } : {}),
    ...(isRecord(provenance)
      ? {
          provenance: Object.fromEntries(
            Object.entries(provenance).filter(([, value]) => value === "stated" || value === "measured"),
          ) as Record<string, Provenance>,
        }
      : {}),
  };
}

function parseLoad(raw: unknown): LoadSegment[] | string {
  if (!Array.isArray(raw)) return "the load is missing or is not a list of steps";
  const segments: LoadSegment[] = [];
  for (const [index, step] of raw.entries()) {
    if (!isRecord(step) || typeof step["rate"] !== "number" || typeof step["duration"] !== "number") {
      return `load step ${index + 1} is missing a rate or a duration`;
    }
    segments.push({ rate: step["rate"], duration: step["duration"] });
  }
  return segments;
}

/**
 * Read a saved file. Never throws: the caller is a drop target.
 *
 * Every rejection names what is wrong with *the file*, because the alternative —
 * a half-loaded model — replaces the author's work with something they did not
 * draw and cannot undo.
 */
export function parse(text: string): ParseResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, error: "That file is not JSON, so it cannot be a saved model." };
  }

  if (!isRecord(raw)) return { ok: false, error: "That file does not contain a saved model." };
  if (raw["format"] !== FILE_FORMAT) {
    return { ok: false, error: "That is not a whiteboard model file — it has no matching format marker." };
  }
  if (typeof raw["version"] !== "number") {
    return { ok: false, error: "That file has no version, so it cannot be read safely." };
  }
  if (raw["version"] > FILE_VERSION) {
    return {
      ok: false,
      error: `That file was saved by a newer version (file ${raw["version"]}, this build reads ${FILE_VERSION}).`,
    };
  }

  const document = raw["document"];
  if (!isRecord(document)) return { ok: false, error: "That file has no model in it." };
  if (!Array.isArray(document["components"])) {
    return { ok: false, error: "That model has no components list." };
  }
  if (!Array.isArray(document["edges"])) {
    return { ok: false, error: "That model has no wiring list." };
  }

  const components: DocumentComponent[] = [];
  for (const [index, raw2] of document["components"].entries()) {
    const parsed = parseComponent(raw2, index);
    if (typeof parsed === "string") return { ok: false, error: `That model could not be read: ${parsed}.` };
    components.push(parsed);
  }

  const edges: DocumentEdge[] = [];
  for (const [index, edge] of document["edges"].entries()) {
    if (!isRecord(edge) || typeof edge["from"] !== "string" || typeof edge["to"] !== "string") {
      return { ok: false, error: `That model could not be read: wire ${index + 1} has no ends.` };
    }
    // `kind` and `times` arrived after version 1. A wire without them is a plain
    // hand-off, which is what every wire meant before dependencies existed.
    // `policy` arrived later still; a call without one never gives up and never
    // asks again, which is what every call did before it. Its contents are
    // checked by `validateDocument`, like a component's spec, not here.
    edges.push({
      from: edge["from"],
      to: edge["to"],
      ...(edge["kind"] === "call" ? { kind: "call" as const } : {}),
      ...(typeof edge["times"] === "number" ? { times: edge["times"] } : {}),
      ...(isRecord(edge["policy"]) ? { policy: edge["policy"] as PartialCallPolicy } : {}),
    });
  }

  const load = parseLoad(document["load"]);
  if (typeof load === "string") return { ok: false, error: `That model could not be read: ${load}.` };
  const pattern = parsePattern(document["pattern"]);
  if (typeof pattern === "string") return { ok: false, error: pattern };

  const defaults = emptyDocument();
  const entryId = document["entryId"];

  return {
    ok: true,
    document: {
      name: typeof document["name"] === "string" ? document["name"] : defaults.name,
      components,
      edges,
      entryId: typeof entryId === "string" ? entryId : null,
      load,
      ...(pattern === undefined ? {} : { pattern }),
      seed: typeof document["seed"] === "string" ? document["seed"] : defaults.seed,
      bucketWidth:
        typeof document["bucketWidth"] === "number" && document["bucketWidth"] > 0
          ? document["bucketWidth"]
          : defaults.bucketWidth,
      delta: parseDelta(document["delta"]),
      disputed: parseDisputed(document["disputed"]),
      sources: parseSources(document["sources"]),
    },
  };
}

/**
 * The load pattern, read like everything else here: schema, not runnability.
 *
 * Absent in every file saved before patterns existed, and those open with the
 * steps they always had. A pattern of a kind this build does not know came from
 * a newer version and is refused, because running the base rate in its place
 * would show a different load from the one the author saved. Settings that are
 * present but out of range are kept for `validateDocument` to name in the editor.
 */
function parsePattern(raw: unknown): ShapedPattern | undefined | string {
  if (raw === undefined || raw === null) return undefined;
  const unreadable = "That model's load pattern could not be read.";
  if (!isRecord(raw)) return unreadable;
  const kind = raw["kind"];
  if (typeof kind !== "string" || !(SHAPED_KINDS as readonly string[]).includes(kind)) {
    return `That model has a load pattern "${String(kind)}" this version does not know. It may come from a newer version.`;
  }
  const numbers = (...keys: string[]): boolean => keys.every((key) => typeof raw[key] === "number");
  switch (kind) {
    case "spiky":
      if (!numbers("height", "every", "lasting")) return unreadable;
      return { kind, height: raw["height"] as number, every: raw["every"] as number, lasting: raw["lasting"] as number };
    case "random":
      if (!numbers("spread", "every")) return unreadable;
      return { kind, spread: raw["spread"] as number, every: raw["every"] as number };
    default:
      if (typeof raw["text"] !== "string") return unreadable;
      return { kind: "formula", text: raw["text"] };
  }
}

/**
 * Other traffic, read leniently — same rule as everything else here.
 *
 * A file saved before other traffic existed opens with none, rather than being
 * refused for a key it could not have known about. A source pointing at a
 * component the file does not contain, or at one that hands work on, is kept and
 * left for `validateDocument` to complain about in the editor, where the author
 * can see which component it means.
 */
function parseSources(raw: unknown): TrafficSource[] {
  if (!Array.isArray(raw)) return [];
  const sources: TrafficSource[] = [];
  for (const entry of raw) {
    if (!isRecord(entry)) continue;
    const { id, name, nodeId, rate } = entry;
    if (typeof id !== "string" || id === "") continue;
    if (typeof nodeId !== "string" || nodeId === "") continue;
    sources.push({
      id,
      name: typeof name === "string" && name !== "" ? name : `other traffic on ${nodeId}`,
      nodeId,
      rate: typeof rate === "number" ? rate : 0,
    });
  }
  return sources;
}

/**
 * The proposal marks and the disputed range, read leniently.
 *
 * Both arrived after version 1 of this format and both are optional, so a file
 * saved before them opens with no proposal and nothing disputed rather than being
 * refused — which is the same rule the rest of this parser follows: schema, not
 * runnability. A mark pointing at a component the file does not contain is left
 * for `validateDocument` to complain about in the editor, where it can be seen
 * next to the model it is wrong about.
 */
function parseDelta(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((id): id is string => typeof id === "string");
}

function parseDisputed(raw: unknown): DisputedParameter | null {
  if (!isRecord(raw)) return null;
  const { componentId, field, min, max } = raw;
  if (typeof componentId !== "string" || typeof field !== "string") return null;
  if (typeof min !== "number" || typeof max !== "number") return null;
  return { componentId, field, min, max };
}

/** A filename an author will recognise a month later. */
export function suggestedFilename(document: WhiteboardDocument): string {
  const stem = document.name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `${stem === "" ? "model" : stem}.whiteboard.json`;
}
