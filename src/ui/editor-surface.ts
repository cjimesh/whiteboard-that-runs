/**
 * The editor: draw a system, connect it, answer a few questions about each part.
 *
 * It is built to be used by somebody who has never read this codebase, which
 * means it asks in their words and compiles to the engine's. A box asks "how many
 * at once?" and "how long does one take?", not `concurrency` and `service.mean`;
 * an arrow asks "what does the app do with the database?", not which of three
 * edge semantics it is. Everything else is set by what the box *is* — the
 * archetype picked from the palette — and folded away under Details.
 *
 * Decisions that shape the rest:
 *
 * **The picture is the same picture.** The editor paints the document through
 * `emptyFrame` and the same renderer the run surface uses, so what an author
 * draws is visibly the thing that runs.
 *
 * **Nothing is arranged by hand.** Layout is derived from the wiring. An author
 * cannot place a box, and in exchange a model is only ever its components, its
 * wiring and its numbers.
 *
 * **One fact, one input.** Capacity is how many at once over how long each takes,
 * so it is said, never typed. Timeout and retries govern a call, so they are asked
 * on the arrow, never on the box.
 *
 * **Guesses are visible.** A number nobody confirmed is *assumed*, and the box
 * says so. The tool claims correct consequences of debatable inputs, so which
 * inputs are guesses is part of the model.
 *
 * **Nothing is lost.** Every change is a new document and the old ones are kept,
 * so starting from a new shape or opening a file can always be undone.
 */
import type { ComponentKind, PartialComponentSpec } from "../specs/format.ts";
import { CONCERNS, resolveSpec } from "../specs/format.ts";
import type { EdgeKind } from "../engine/timeline.ts";
import { describeCallPolicy, parseRetries, resolveCallPolicy, withCallRetries, withCallTimeout } from "../specs/call-policy.ts";
import { parseTimeout, withTimeout } from "../specs/timeout.ts";
import { withRetryCount } from "../specs/retry.ts";
import { capacityOf } from "../specs/capacity.ts";
import { presets } from "../specs/registry.ts";
import { ARCHETYPES, addArchetype, archetypeOf } from "../model/archetypes.ts";
import {
  addTrafficSource,
  connect,
  disconnect,
  emptyDocument,
  pointsBackwards,
  removeComponent,
  removeTrafficSource,
  renameComponent,
  setCallPolicy,
  setCallTimes,
  setDisputed,
  setEdgeKind,
  setEntry,
  setLoad,
  setName,
  setPattern,
  setPatternKind,
  loadPatternOf,
  setProposal,
  setProvenance,
  setSpec,
  setTrafficSource,
  toTimeline,
  validateDocument,
  type DocumentComponent,
  type DocumentEdge,
  type Provenance,
  type WhiteboardDocument,
} from "../model/document.ts";
import { parse, serialize, suggestedFilename } from "../model/persist.ts";
import { patternSegments, summarizePattern, type PatternKind, type ShapedPattern } from "../model/load-pattern.ts";
import { PATTERN_LABELS, patternFields } from "./pattern-fields.ts";
import { emptyFrame, type Frame } from "../view/frame.ts";
import { createRenderer, type Decorations, type Renderer } from "../view/renderer.ts";
import { fieldsFor, tierOf, type ParamField } from "../model/params.ts";
import { STARTING_SHAPES } from "./starting-shapes.ts";

export interface EditorSurface {
  element: HTMLElement;
  start(): void;
  document(): WhiteboardDocument;
  destroy(): void;
}

export interface EditorOptions {
  document?: WhiteboardDocument;
  /** Called with a runnable document when the author presses Run. */
  onRun: (document: WhiteboardDocument) => void;
  /**
   * Called when the document on screen has nothing left to lose: just saved,
   * just opened from a file, or just started from a shape.
   */
  onClean?: (document: WhiteboardDocument) => void;
  /**
   * What Undo goes back to first: the model before changes were kept from a run,
   * so keeping them is undone like any edit made here.
   */
  undoTo?: WhiteboardDocument;
}

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className !== undefined) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(label: string, action: string, className = "wtr-button"): HTMLButtonElement {
  const node = element("button", className, label);
  node.type = "button";
  node.dataset["action"] = action;
  return node;
}

function textInput(className = "wtr-number"): HTMLInputElement {
  const input = element("input", className);
  input.type = "text";
  input.inputMode = "decimal";
  return input;
}

/** What a kind is called when no archetype says better — older models, mostly. */
const KIND_LABEL: Record<ComponentKind, string> = {
  service: "App server",
  queue: "Queue",
  balancer: "Load balancer",
  cache: "Cache",
  datastore: "Datastore",
};

export function labelOf(component: DocumentComponent): string {
  return archetypeOf(component)?.label ?? KIND_LABEL[component.kind];
}

/** The three things a wire can mean, in the words the arrow asks them in. */
type Relation = "forward-wait" | "forward-handoff" | "call";

const RELATION_LABEL: Record<Relation, string> = {
  "forward-wait": "Passes the request on, and waits for the reply",
  "forward-handoff": "Passes the request on, and moves on",
  call: "Asks it something along the way, then carries on",
};

const RELATION_NOTE: Record<Relation, string> = {
  "forward-wait":
    "Holds one of its own slots until the answer comes back, so if this is slow, the sender fills up too.",
  "forward-handoff": "Frees its slot as soon as the work is handed over, like dropping a message on a queue.",
  call: "Asks, waits for the answer, then carries on to wherever it sends its work. Use this for a shared database or store that many things lean on.",
};

const PROVENANCE_LABEL: Record<"assumed" | Provenance, string> = {
  assumed: "assumed",
  stated: "stated",
  measured: "measured",
};

const NEXT_PROVENANCE: Record<"assumed" | Provenance, Provenance | null> = {
  assumed: "stated",
  stated: "measured",
  measured: null,
};

/** How much a field's number is known. */
export function provenanceOf(component: DocumentComponent, key: string): "assumed" | Provenance {
  return component.provenance?.[key] ?? "assumed";
}

/** The numbers every component of this kind is asked up front. */
export function coreFields(component: DocumentComponent): ParamField[] {
  return fieldsFor(component.kind).filter((field) => tierOf(field, component.spec) === "core");
}

/** Components whose every core number is still a guess. Balancers have none to guess. */
export function whollyAssumed(document: WhiteboardDocument): Set<string> {
  const assumed = new Set<string>();
  for (const component of document.components) {
    const numbers = coreFields(component).filter((field) => field.control !== "select");
    if (numbers.length > 0 && numbers.every((field) => provenanceOf(component, field.key) === "assumed")) {
      assumed.add(component.id);
    }
  }
  return assumed;
}

/**
 * The first problem with each component, for a badge on its box.
 *
 * Read off the validation messages, which quote every component they are about
 * by name: one list of problems, two places it is shown, and no second checker
 * to drift from the first.
 */
export function problemsByComponent(document: WhiteboardDocument): Map<string, string> {
  const ids = new Set(document.components.map((component) => component.id));
  const problems = new Map<string, string>();
  for (const message of validateDocument(document).errors) {
    for (const match of message.matchAll(/"([^"]+)"/g)) {
      const id = match[1] as string;
      if (ids.has(id) && !problems.has(id)) problems.set(id, message);
    }
  }
  return problems;
}

/**
 * What a new connection should mean before anyone says.
 *
 * A component already handing its work somewhere cannot hand it to a second
 * place (only a balancer splits work), so a second wire out of it is almost
 * always something it asks along the way. Defaulting to that keeps the model
 * runnable; the arrow then asks, so the guess is never silent.
 */
export function defaultEdgeKind(document: WhiteboardDocument, from: string): EdgeKind {
  const source = document.components.find((component) => component.id === from);
  if (source === undefined || source.kind === "balancer") return "forward";
  const handsOn = document.edges.some((edge) => edge.from === from && (edge.kind ?? "forward") === "forward");
  return handsOn ? "call" : "forward";
}

function relationOf(document: WhiteboardDocument, edge: DocumentEdge): Relation {
  if (edge.kind === "call") return "call";
  const source = document.components.find((component) => component.id === edge.from);
  if (source === undefined || !CONCERNS[source.kind].includes("downstream")) return "forward-wait";
  return resolveSpec(source.kind, source.spec).downstream.policy === "fire-and-forget" ? "forward-handoff" : "forward-wait";
}

/** Which of the three a wire out of this kind may mean. */
function relationsFor(kind: ComponentKind): Relation[] {
  if (kind === "balancer") return ["forward-wait"];
  return CONCERNS[kind].includes("downstream") ? ["forward-wait", "forward-handoff", "call"] : ["forward-wait", "call"];
}

function plainRate(perSecond: number): string {
  if (!Number.isFinite(perSecond)) return "without limit";
  if (perSecond >= 100) return `about ${Math.round(perSecond).toLocaleString("en-US")} a second`;
  if (perSecond >= 10) return `about ${Number(perSecond.toFixed(1))} a second`;
  return `about ${Number(perSecond.toFixed(2))} a second`;
}

/** The capacity sentence under a box's questions: said, never typed. */
function capacitySentence(component: DocumentComponent): string | null {
  const reading = capacityOf(component.kind, component.spec);
  if (reading === null) return null;
  const base = `Can serve ${plainRate(reading.perSecond)}`;
  if (!reading.leased) return `${base}.`;
  return `${base}, because each slot stays taken for ${Number(reading.meanSeconds.toFixed(2))} s whatever the work takes.`;
}

const HISTORY_LIMIT = 100;

export function createEditorSurface(options: EditorOptions): EditorSurface {
  let doc = options.document ?? emptyDocument();
  const past: WhiteboardDocument[] = options.undoTo === undefined ? [] : [options.undoTo];
  const future: WhiteboardDocument[] = [];

  let selected: { kind: "component"; id: string } | { kind: "edge"; from: string; to: string } | null = null;
  /** Set while the author is connecting from a component with the button rather than a drag. */
  let connectingFrom: string | null = null;
  let fileMessage = "";
  let detailsOpen = false;
  let chooserOpen = false;

  const root = element("section", "wtr-editor-surface");
  root.dataset["surface"] = "editor";

  // ------------------------------------------------------------------ header
  const nameInput = element("input", "wtr-name");
  nameInput.type = "text";
  nameInput.dataset["action"] = "name";
  nameInput.setAttribute("aria-label", "Model name");

  const newButton = button("New…", "new");
  newButton.title = "Start from a common shape, or a blank canvas. Undo brings this one back.";

  const openInput = element("input");
  openInput.type = "file";
  openInput.accept = ".json,application/json";
  openInput.dataset["action"] = "open";
  openInput.className = "wtr-file";
  const openLabel = element("label", "wtr-button", "Open…");
  openLabel.append(openInput);

  const saveButton = button("Save", "save");
  const undoButton = button("Undo", "undo");
  undoButton.title = "Undo the last change (Ctrl+Z)";
  const redoButton = button("Redo", "redo");
  redoButton.title = "Redo (Ctrl+Shift+Z)";
  const runButton = button("Run ▸", "run", "wtr-button wtr-button-primary");

  const header = element("header", "wtr-editor-header");
  header.append(nameInput, newButton, openLabel, saveButton, undoButton, redoButton, runButton);

  // ------------------------------------------------------------------ canvas
  const stage = element("div", "wtr-stage");
  const canvas = element("canvas", "wtr-canvas");
  const chooser = element("div", "wtr-chooser");
  chooser.dataset["chooser"] = "closed";
  stage.append(canvas, chooser);

  const hint = element("p", "wtr-hint");
  hint.dataset["hint"] = "";

  // ----------------------------------------------------------------- columns
  const palette = element("div", "wtr-palette");
  const inspector = element("div", "wtr-inspector");
  const loadPanel = element("div", "wtr-load");
  const assumptions = element("div", "wtr-assumptions");
  const problems = element("div", "wtr-problems");
  problems.dataset["problems"] = "";

  const controlColumn = element("aside", "wtr-controls");
  controlColumn.append(palette, inspector, loadPanel, assumptions);

  root.append(header, hint, stage, problems, controlColumn);

  let renderer: Renderer | null = null;
  let frame: Frame = emptyFrame(toTimeline(doc).model);
  let dragLine: { x1: number; y1: number; x2: number; y2: number } | null = null;

  /** The last settings of each shaped pattern, so flipping away and back keeps them. */
  const shapes: Partial<Record<ShapedPattern["kind"], ShapedPattern>> = {};

  /** Every change goes through here, so every change can be undone. */
  const update = (next: WhiteboardDocument): void => {
    if (next === doc) {
      render();
      return;
    }
    past.push(doc);
    if (past.length > HISTORY_LIMIT) past.shift();
    future.length = 0;
    doc = next;
    render();
  };

  /** Drop a selection that no longer points at anything, after undo or a delete. */
  const reconcileSelection = (): void => {
    if (selected === null) return;
    if (selected.kind === "component") {
      const { id } = selected;
      if (!doc.components.some((component) => component.id === id)) selected = null;
    } else {
      const { from, to } = selected;
      if (!doc.edges.some((edge) => edge.from === from && edge.to === to)) selected = null;
    }
  };

  const undo = (): void => {
    const previous = past.pop();
    if (previous === undefined) return;
    future.push(doc);
    doc = previous;
    render();
  };

  const redo = (): void => {
    const next = future.pop();
    if (next === undefined) return;
    past.push(doc);
    doc = next;
    render();
  };

  /** A spec edit, which also means this is no longer the preset it started as. */
  const updateSpec = (component: DocumentComponent, spec: PartialComponentSpec, provenanceKey?: string): void => {
    let next: WhiteboardDocument = {
      ...setSpec(doc, component.id, spec),
      components: doc.components.map((candidate) =>
        candidate.id === component.id ? { ...candidate, preset: null, spec } : candidate,
      ),
    };
    // Typing a number is stating it. A measurement that has just been typed over
    // is no longer that measurement, so it goes back to stated too.
    if (provenanceKey !== undefined) next = setProvenance(next, component.id, provenanceKey, "stated");
    update(next);
  };

  // ----------------------------------------------------------------- palette
  const renderPalette = (): void => {
    palette.replaceChildren(element("h2", "wtr-panel-title", "Add"));
    const row = element("div", "wtr-palette-row");
    for (const archetype of ARCHETYPES) {
      const add = button(archetype.label, `add:${archetype.id}`);
      add.title = archetype.blurb;
      add.addEventListener("click", () => {
        const added = addArchetype(doc, archetype.id);
        selected = { kind: "component", id: added.id };
        connectingFrom = null;
        update(added.document);
      });
      row.append(add);
    }
    palette.append(row);
  };

  // ------------------------------------------------------------- one field
  const renderField = (component: DocumentComponent, field: ParamField, withProvenance: boolean): HTMLElement => {
    const group = element("div", "wtr-preset-group");
    group.dataset["field"] = field.key;
    const label = element("label", "wtr-field");
    label.append(element("span", "wtr-field-label", field.label));

    const error = element("p", "wtr-field-error");
    error.setAttribute("role", "alert");

    const commit = (raw: string): void => {
      const applied = field.apply(component.spec, raw);
      if (!applied.ok) {
        error.textContent = applied.error;
        return;
      }
      error.textContent = "";
      updateSpec(component, applied.spec, field.control === "select" ? undefined : field.key);
    };

    if (field.control === "select") {
      const select = element("select", "wtr-select");
      select.dataset["param"] = field.key;
      select.setAttribute("aria-label", field.label);
      for (const option of field.options ?? []) {
        const item = element("option", undefined, option.label);
        item.value = option.value;
        if (option.value === field.value(component.spec)) item.selected = true;
        select.append(item);
      }
      select.addEventListener("change", () => commit(select.value));
      label.append(select);
    } else {
      const input = textInput();
      input.dataset["param"] = field.key;
      input.setAttribute("aria-label", field.label);
      input.value = field.value(component.spec);
      input.addEventListener("change", () => commit(input.value));
      label.append(input);
      if (field.unit !== undefined) label.append(element("span", "wtr-field-unit", field.unit));
    }

    group.append(label);
    const description = field.describe?.(component.spec) ?? "";
    if (description !== "") group.append(element("p", "wtr-preset-note", description));

    const tools = element("div", "wtr-field-tools");
    if (withProvenance && field.control !== "select") {
      // One click to say how much this number is known. Cycles rather than opens
      // a menu: three states, and the common move is assumed → stated.
      const state = provenanceOf(component, field.key);
      const chip = button(PROVENANCE_LABEL[state], `provenance:${field.key}`, "wtr-chip");
      chip.dataset["provenance"] = state;
      chip.title =
        state === "assumed"
          ? "A guess nobody has confirmed. Click when somebody states it."
          : state === "stated"
            ? "Somebody said so. Click if it was measured in production."
            : "Measured. Click to mark it as a guess again.";
      chip.addEventListener("click", () =>
        update(setProvenance(doc, component.id, field.key, NEXT_PROVENANCE[state])),
      );
      tools.append(chip);
    }
    if (field.control !== "select") tools.append(...renderDispute(component, field, error));
    if (tools.childElementCount > 0) group.append(tools);
    group.append(error);
    return group;
  };

  /**
   * Disputing a number (R10): the room does not agree, so the breaking point is
   * reported across the range. One at a time — two disputed ranges would be four
   * sweeps of a claim nobody could restate in a sentence.
   */
  const renderDispute = (component: DocumentComponent, field: ParamField, error: HTMLElement): HTMLElement[] => {
    const disputed =
      doc.disputed !== null && doc.disputed.componentId === component.id && doc.disputed.field === field.key
        ? doc.disputed
        : null;

    const toggle = button(
      disputed === null ? "Disputed?" : "Stop disputing",
      `dispute:${field.key}`,
      "wtr-button wtr-button-small wtr-dispute-toggle",
    );
    toggle.dataset["disputed"] = String(disputed !== null);
    toggle.title =
      disputed === null
        ? "Nobody agrees on this number? Give the range, and the breaking point is reported across it."
        : "Stop treating this as disputed.";
    toggle.addEventListener("click", () => {
      if (disputed !== null) {
        update(setDisputed(doc, null));
        return;
      }
      // Seeded at ±20% of the current value: a range an author only has to widen
      // is a range they will actually set.
      const current = Number(field.value(component.spec));
      const base = Number.isFinite(current) && current > 0 ? current : 1;
      update(
        setDisputed(doc, {
          componentId: component.id,
          field: field.key,
          min: Number((base * 0.8).toFixed(2)),
          max: Number((base * 1.2).toFixed(2)),
        }),
      );
    });

    if (disputed === null) return [toggle];

    const range = element("div", "wtr-dispute-range");
    for (const end of ["min", "max"] as const) {
      const bound = element("label", "wtr-field");
      bound.append(element("span", "wtr-field-label", end === "min" ? "Low" : "High"));
      const input = textInput("wtr-number wtr-number-small");
      input.dataset["dispute"] = end;
      input.setAttribute("aria-label", `${field.noun} ${end === "min" ? "low" : "high"} end`);
      input.value = String(disputed[end]);
      input.addEventListener("change", () => {
        const value = Number(input.value.trim());
        if (!Number.isFinite(value)) {
          error.textContent = `The ${end === "min" ? "low" : "high"} end has to be a number.`;
          return;
        }
        error.textContent = "";
        update(setDisputed(doc, { ...disputed, [end]: value }));
      });
      bound.append(input);
      if (field.unit !== undefined) bound.append(element("span", "wtr-field-unit", field.unit));
      range.append(bound);
    }
    return [toggle, range];
  };

  // ------------------------------------------------------ component inspector
  const renderComponent = (component: DocumentComponent): void => {
    const heading = element("div", "wtr-panel-heading");
    const name = element("input", "wtr-name wtr-name-heading");
    name.type = "text";
    name.value = component.id;
    name.dataset["action"] = "rename";
    name.setAttribute("aria-label", "Component name");
    name.addEventListener("change", () => {
      const renamed = renameComponent(doc, component.id, name.value);
      if (renamed === doc) {
        name.value = component.id;
        return;
      }
      selected = { kind: "component", id: name.value.trim() };
      update(renamed);
    });
    const kindTag = element("span", "wtr-panel-kind", labelOf(component));
    kindTag.dataset["kind"] = component.kind;
    heading.append(name, kindTag);
    inspector.append(heading);

    const blurb = archetypeOf(component)?.blurb;
    if (blurb !== undefined) inspector.append(element("p", "wtr-preset-note", blurb));

    const problem = problemsByComponent(doc).get(component.id);
    if (problem !== undefined) {
      const note = element("p", "wtr-problem-note", problem);
      note.dataset["componentProblem"] = component.id;
      inspector.append(note);
    }

    // The questions every component of this kind is asked, then what they add up to.
    for (const field of coreFields(component)) inspector.append(renderField(component, field, true));
    const capacity = capacitySentence(component);
    if (capacity !== null) {
      const line = element("p", "wtr-capacity", capacity);
      line.dataset["capacity"] = component.id;
      inspector.append(line);
    }
    // A dispute saved against capacity, from before capacity became a readout:
    // shown here so it can still be seen and changed.
    const legacy = fieldsFor(component.kind).find((field) => field.key === "capacity");
    if (legacy !== undefined && doc.disputed?.componentId === component.id && doc.disputed.field === "capacity") {
      const error = element("p", "wtr-field-error");
      inspector.append(...renderDispute(component, legacy, error), error);
    }

    const actions = element("div", "wtr-inspector-actions");
    const connecting = connectingFrom === component.id;
    const connectButton = button(connecting ? "Click a box…" : "Sends requests to…", "connect");
    connectButton.title = `Then click the box ${component.id} sends requests to. Or drag from this box to that one.`;
    connectButton.addEventListener("click", () => {
      connectingFrom = connecting ? null : component.id;
      render();
    });

    const isEntry = doc.entryId === component.id;
    const entryButton = button(isEntry ? "Requests arrive here ✓" : "Requests arrive here", "make-entry");
    entryButton.disabled = isEntry;
    entryButton.title = "Where the offered load enters the system.";
    entryButton.addEventListener("click", () => update(setEntry(doc, component.id)));

    // Marking what the proposal *adds* (R9). The baseline is derived by taking
    // these out, so an author keeps one model rather than two copies.
    const inProposal = doc.delta.includes(component.id);
    const proposalButton = button(inProposal ? "New in this proposal ✓" : "New in this proposal", "proposal");
    proposalButton.dataset["marked"] = String(inProposal);
    proposalButton.title = inProposal
      ? "Part of this proposal. The breaking point is reported with and without it."
      : "Mark this as something the proposal adds, so the breaking point can be reported with and without it.";
    proposalButton.addEventListener("click", () => update(setProposal(doc, component.id, !inProposal)));

    const deleteButton = button("Delete", "delete");
    deleteButton.addEventListener("click", () => {
      selected = null;
      connectingFrom = null;
      update(removeComponent(doc, component.id));
    });
    actions.append(connectButton, entryButton, proposalButton, deleteButton);
    inspector.append(actions);

    // Its arrows, each a way into the arrow's own questions.
    const outgoing = doc.edges.filter((edge) => edge.from === component.id);
    if (outgoing.length > 0) {
      inspector.append(element("h3", "wtr-panel-subtitle", "Arrows out"));
      const list = element("ul", "wtr-wire-list");
      for (const edge of outgoing) {
        const item = element("li", "wtr-wire-item");
        const open = button(
          `${edge.kind === "call" ? "⇢" : "→"} ${edge.to} · ${RELATION_LABEL[relationOf(doc, edge)].toLowerCase()}`,
          `select-arrow:${edge.to}`,
          "wtr-link",
        );
        open.addEventListener("click", () => {
          selected = { kind: "edge", from: edge.from, to: edge.to };
          render();
        });
        item.append(open);
        list.append(item);
      }
      inspector.append(list);
    }

    renderOtherTraffic(component.id, outgoing.length > 0);

    // Everything the archetype already decided, for the author who wants it.
    const details = element("details", "wtr-details");
    details.dataset["section"] = "details";
    details.open = detailsOpen;
    details.addEventListener("toggle", () => {
      detailsOpen = details.open;
    });
    details.append(element("summary", "wtr-details-summary", "Details"));

    const available = presets.list(component.kind);
    if (available.length > 0) {
      const select = element("select", "wtr-select");
      select.dataset["action"] = "preset";
      select.setAttribute("aria-label", "Behaves like");
      const custom = element("option", undefined, component.preset === null ? "As set by hand" : "As set by hand…");
      custom.value = "";
      select.append(custom);
      for (const preset of available) {
        const option = element("option", undefined, preset.label);
        option.value = preset.name;
        if (preset.name === component.preset) option.selected = true;
        select.append(option);
      }
      select.addEventListener("change", () => {
        if (select.value === "") return;
        const preset = presets.get(select.value);
        // A preset replaces the spec wholesale, so every number is its guess now.
        const { provenance: _cleared, ...rest } = component;
        update({
          ...doc,
          components: doc.components.map((candidate) =>
            candidate.id === component.id
              ? { ...rest, preset: preset.name, spec: preset.spec as PartialComponentSpec }
              : candidate,
          ),
        });
      });
      const field = element("label", "wtr-field");
      field.append(element("span", "wtr-field-label", "Behaves like"), select);
      const group = element("div", "wtr-preset-group");
      group.append(field);
      const note = available.find((preset) => preset.name === component.preset)?.note;
      if (note !== undefined) group.append(element("p", "wtr-preset-note", note));
      details.append(group);
    }
    for (const field of fieldsFor(component.kind)) {
      if (tierOf(field, component.spec) === "details") details.append(renderField(component, field, false));
    }
    inspector.append(details);
  };

  // ----------------------------------------------------------- arrow inspector
  const renderEdge = (edge: DocumentEdge): void => {
    const source = doc.components.find((component) => component.id === edge.from);
    const target = doc.components.find((component) => component.id === edge.to);
    if (source === undefined || target === undefined) return;

    const heading = element("div", "wtr-panel-heading");
    heading.append(element("h2", "wtr-panel-title", `${edge.from} → ${edge.to}`));
    inspector.append(heading);

    const relation = relationOf(doc, edge);
    const allowed = relationsFor(source.kind);

    if (allowed.length > 1) {
      inspector.append(element("p", "wtr-question", `What does ${edge.from} do with ${edge.to}?`));
      const choices = element("div", "wtr-choices");
      choices.setAttribute("role", "radiogroup");
      for (const option of allowed) {
        const choice = button(RELATION_LABEL[option], `relation:${option}`, "wtr-choice");
        choice.setAttribute("role", "radio");
        choice.setAttribute("aria-checked", String(option === relation));
        choice.dataset["selected"] = String(option === relation);
        choice.addEventListener("click", () => {
          let next = setEdgeKind(doc, edge.from, edge.to, option === "call" ? "call" : "forward");
          if (option !== "call" && CONCERNS[source.kind].includes("downstream")) {
            const current = next.components.find((component) => component.id === source.id) ?? source;
            const policy = option === "forward-handoff" ? "fire-and-forget" : "call-and-wait";
            const spec: PartialComponentSpec = { ...current.spec, downstream: { policy } };
            next = {
              ...setSpec(next, source.id, spec),
              components: next.components.map((component) =>
                component.id === source.id ? { ...component, preset: null, spec } : component,
              ),
            };
          }
          update(next);
        });
        choices.append(choice);
      }
      inspector.append(choices);
    }
    inspector.append(element("p", "wtr-preset-note", RELATION_NOTE[relation]));

    // Said here, on the arrow, because this is where it can be fixed: the first
    // person to try the editor drew "connect app to balancer" as app → balancer.
    const backwards = pointsBackwards(doc, edge.from, edge.to);
    const problem = problemsByComponent(doc).get(edge.from);
    if (backwards) {
      const note = element(
        "p",
        "wtr-problem-note",
        `Requests reach ${edge.to} but never reach ${edge.from}, so this arrow probably points the wrong way. ` +
          `If ${edge.to} sends requests to ${edge.from}, flip it.`,
      );
      note.dataset["backwards"] = "true";
      inspector.append(note);
    } else if (problem !== undefined && problem.includes(`"${edge.to}"`)) {
      inspector.append(element("p", "wtr-problem-note", problem));
    }

    const error = element("p", "wtr-field-error");
    error.setAttribute("role", "alert");

    if (relation === "call") {
      const times = textInput("wtr-number wtr-number-small");
      times.inputMode = "numeric";
      times.dataset["arrowTimes"] = edge.to;
      times.setAttribute("aria-label", `Times per request`);
      times.value = String(edge.times ?? 1);
      times.addEventListener("change", () => update(setCallTimes(doc, edge.from, edge.to, Number(times.value.trim()))));
      const row = element("label", "wtr-field");
      row.append(element("span", "wtr-field-label", "How many times per request?"), times);
      inspector.append(row);
    }

    // "If it's slow": the timeout and retries that govern this call, wherever the
    // engine keeps them. On a hand-off they are the sender's own settings; on a
    // call they belong to the call.
    const governsSlow = relation === "call" || (relation === "forward-wait" && CONCERNS[source.kind].includes("timeout"));
    if (governsSlow) {
      inspector.append(element("h3", "wtr-panel-subtitle", "If it is slow"));
      const policy =
        relation === "call"
          ? resolveCallPolicy(edge.policy ?? {})
          : (() => {
              const resolved = resolveSpec(source.kind, source.spec);
              return { timeout: resolved.timeout, retry: resolved.retry };
            })();

      const timeout = textInput("wtr-number wtr-number-small");
      timeout.dataset["arrowTimeout"] = edge.to;
      timeout.setAttribute("aria-label", "Gives up after, ms");
      timeout.value = policy.timeout.policy === "none" ? "off" : String(Number((policy.timeout.after * 1000).toFixed(2)));
      timeout.addEventListener("change", () => {
        const parsed = parseTimeout(timeout.value);
        if (!parsed.ok) {
          error.textContent = parsed.error;
          return;
        }
        if (relation === "call") {
          update(setCallPolicy(doc, edge.from, edge.to, withCallTimeout(edge.policy ?? {}, parsed.milliseconds)));
        } else {
          updateSpec(source, withTimeout(source.kind, source.spec, parsed.milliseconds));
        }
      });

      const retries = textInput("wtr-number wtr-number-small");
      retries.inputMode = "numeric";
      retries.dataset["arrowRetries"] = edge.to;
      retries.setAttribute("aria-label", "Retries");
      retries.value = policy.retry.policy === "none" ? "off" : String(policy.retry.attempts);
      retries.addEventListener("change", () => {
        const parsed = parseRetries(retries.value);
        if (!parsed.ok) {
          error.textContent = parsed.error;
          return;
        }
        if (relation === "call") {
          update(setCallPolicy(doc, edge.from, edge.to, withCallRetries(edge.policy ?? {}, parsed.attempts)));
        } else {
          const resolved = resolveSpec(source.kind, source.spec);
          updateSpec(source, { ...source.spec, retry: withRetryCount(resolved.retry, parsed.attempts) });
        }
      });

      const giveUp = element("label", "wtr-field");
      giveUp.append(element("span", "wtr-field-label", "Gives up after"), timeout, element("span", "wtr-field-unit", "ms"));
      const askAgain = element("label", "wtr-field");
      askAgain.append(element("span", "wtr-field-label", "Then asks again"), retries, element("span", "wtr-field-unit", "times"));
      const sentence = element("p", "wtr-capacity", describeCallPolicy(policy));
      sentence.dataset["arrowPolicy"] = edge.to;
      inspector.append(giveUp, askAgain, sentence);
    }
    inspector.append(error);

    const remove = button("Remove arrow", "unwire");
    remove.addEventListener("click", () => {
      selected = { kind: "component", id: edge.from };
      update(disconnect(doc, edge.from, edge.to));
    });
    const back = button(`Back to ${edge.from}`, "select-source", "wtr-button");
    back.addEventListener("click", () => {
      selected = { kind: "component", id: edge.from };
      render();
    });
    // A flipped arrow is a new arrow: its meaning is guessed afresh for its new
    // sender and asked again, rather than carrying over answers given about the
    // other direction.
    const flip = button("Flip direction", "flip", backwards ? "wtr-button wtr-button-primary" : "wtr-button");
    flip.title = `Make it ${edge.to} → ${edge.from}.`;
    flip.addEventListener("click", () => {
      const without = disconnect(doc, edge.from, edge.to);
      selected = { kind: "edge", from: edge.to, to: edge.from };
      update(connect(without, edge.to, edge.from, defaultEdgeKind(without, edge.to)));
    });
    const actions = element("div", "wtr-inspector-actions");
    actions.append(back, flip, remove);
    inspector.append(actions);
  };

  const renderInspector = (): void => {
    inspector.replaceChildren();
    reconcileSelection();

    if (selected === null) {
      inspector.append(
        element("h2", "wtr-panel-title", "Nothing selected"),
        element(
          "p",
          "wtr-preset-note",
          doc.components.length === 0
            ? "Add a component, or start from a common shape with New…"
            : "Click a box to set it up, or an arrow to say how two boxes talk. Drag from a box to the box it sends requests to.",
        ),
      );
      return;
    }

    if (selected.kind === "component") {
      const { id } = selected;
      const component = doc.components.find((candidate) => candidate.id === id);
      if (component !== undefined) renderComponent(component);
      return;
    }

    const { from, to } = selected;
    const edge = doc.edges.find((candidate) => candidate.from === from && candidate.to === to);
    if (edge !== undefined) renderEdge(edge);
  };

  /**
   * The load this component already carries for somebody else.
   *
   * Offered on a component nothing is wired out of, because that is where other
   * traffic can be stated without inventing where it goes next. Also shown, with
   * the problem said out loud, on a component that has other traffic and has
   * since been wired onward: otherwise the only fix would be to delete it.
   */
  const renderOtherTraffic = (componentId: string, handsWorkOn: boolean): void => {
    const sources = doc.sources.filter((source) => source.nodeId === componentId);
    if (handsWorkOn && sources.length === 0) return;

    inspector.append(element("h3", "wtr-panel-subtitle", "Other traffic"));
    inspector.append(
      element(
        "p",
        "wtr-preset-note",
        handsWorkOn
          ? `"${componentId}" hands work on to something else, so other traffic cannot be stated here — ` +
              "this model knows what it does for this path, not what the other traffic asks of it. " +
              "Remove the traffic, or the arrow."
          : "Load from things not drawn here — other products, batch jobs — in requests per second. " +
              "It takes up room here and goes no further.",
      ),
    );

    for (const source of sources) {
      const row = element("div", "wtr-traffic-row");

      const name = element("input", "wtr-name wtr-name-small");
      name.type = "text";
      name.setAttribute("data-traffic-name", source.id);
      name.setAttribute("aria-label", `What ${source.id} is`);
      name.value = source.name;
      name.addEventListener("change", () => update(setTrafficSource(doc, source.id, { name: name.value })));

      const rate = textInput("wtr-number wtr-number-small");
      rate.setAttribute("data-traffic-rate", source.id);
      rate.setAttribute("aria-label", `${source.name} rate`);
      rate.value = String(source.rate);
      // Kept as a number even when it is not one, so `validateDocument` names it.
      rate.addEventListener("change", () => update(setTrafficSource(doc, source.id, { rate: Number(rate.value) })));

      const remove = button("✕", `remove-traffic:${source.id}`, "wtr-button wtr-button-small");
      remove.addEventListener("click", () => update(removeTrafficSource(doc, source.id)));

      row.append(name, rate, element("span", "wtr-field-unit", "/s"), remove);
      inspector.append(row);
    }

    if (handsWorkOn) return;

    const add = button("Add other traffic", `add-traffic:${componentId}`, "wtr-button wtr-button-small wtr-traffic-add");
    // Starts at zero rather than at a plausible-looking default: a number this
    // tool invented would be indistinguishable, later, from one the author knew.
    add.addEventListener("click", () => update(addTrafficSource(doc, componentId).document));
    inspector.append(add);
  };

  // ------------------------------------------------------------------- load
  const renderLoad = (): void => {
    loadPanel.replaceChildren(element("h2", "wtr-panel-title", "Requests per second"));
    const { pattern } = loadPatternOf(doc);
    if (pattern.kind !== "steady" && pattern.kind !== "steps") shapes[pattern.kind] = pattern;

    const kinds = element("select", "wtr-select");
    kinds.dataset["action"] = "load-pattern";
    kinds.setAttribute("aria-label", "Load pattern");
    for (const kind of Object.keys(PATTERN_LABELS) as PatternKind[]) {
      const option = element("option", undefined, PATTERN_LABELS[kind]);
      option.value = kind;
      if (kind === pattern.kind) option.selected = true;
      kinds.append(option);
    }
    kinds.addEventListener("change", () => {
      const kind = kinds.value as PatternKind;
      update(setPatternKind(doc, kind, kind === "steady" || kind === "steps" ? undefined : shapes[kind]));
    });
    const kindField = element("label", "wtr-field");
    kindField.append(element("span", "wtr-field-label", "Pattern"), kinds);
    loadPanel.append(kindField);

    if (pattern.kind !== "steady" && pattern.kind !== "steps") {
      renderShapedLoad(pattern);
      return;
    }

    doc.load.forEach((segment, index) => {
      const row = element("div", "wtr-load-row");

      const rate = textInput("wtr-number wtr-number-small");
      // `setAttribute`, not `dataset`: a DOMStringMap key must be camelCase, and
      // `dataset["load-rate"]` throws in Chrome while happy-dom accepts it.
      rate.setAttribute("data-load-rate", String(index));
      rate.setAttribute("aria-label", `Step ${index + 1} rate`);
      rate.value = String(segment.rate);

      const duration = textInput("wtr-number wtr-number-small");
      duration.setAttribute("data-load-duration", String(index));
      duration.setAttribute("aria-label", `Step ${index + 1} duration`);
      duration.value = String(segment.duration);

      const write = (): void => {
        const next = [...doc.load];
        // Invalid text is kept as a number so `validateDocument` names the step.
        next[index] = { rate: Number(rate.value), duration: Number(duration.value) };
        update(setLoad(doc, next));
      };
      rate.addEventListener("change", write);
      duration.addEventListener("change", write);

      const remove = button("✕", `remove-step:${index}`, "wtr-button wtr-button-small");
      remove.disabled = doc.load.length === 1;
      remove.addEventListener("click", () => update(setLoad(doc, doc.load.filter((_, i) => i !== index))));

      // One step reads as a rate; several read as a shape over time.
      if (doc.load.length === 1) {
        row.append(rate, element("span", "wtr-field-unit", "/s"));
      } else {
        row.append(rate, element("span", "wtr-field-unit", "/s for"), duration, element("span", "wtr-field-unit", "s"), remove);
      }
      loadPanel.append(row);
    });

    const add = button(doc.load.length === 1 ? "Add a step…" : "Add step", "add-step", "wtr-button wtr-button-small");
    add.addEventListener("click", () => {
      const last = doc.load[doc.load.length - 1];
      update(setLoad(doc, [...doc.load, { rate: last === undefined ? 20 : last.rate, duration: 60 }]));
    });
    loadPanel.append(add);
  };

  /**
   * A spiky, random or formula load: the base rate, the pattern's settings, and
   * what they add up to. The same fields the run surface shows, so a pattern set
   * here reads the same way when it is steered live.
   */
  const renderShapedLoad = (pattern: ShapedPattern): void => {
    const rate = textInput("wtr-number wtr-number-small");
    rate.setAttribute("data-load-rate", "0");
    rate.setAttribute("aria-label", "Base rate");
    rate.value = String(doc.load[0]?.rate ?? 0);
    rate.addEventListener("change", () => {
      // Invalid text is kept as a number so `validateDocument` names the step.
      update(setLoad(doc, [{ rate: Number(rate.value), duration: doc.load[0]?.duration ?? 3600 }]));
    });
    const baseRow = element("label", "wtr-field wtr-load-row");
    baseRow.append(element("span", "wtr-field-label", "Base"), rate, element("span", "wtr-field-unit", "/s"));

    const error = element("p", "wtr-pattern-error");
    error.setAttribute("role", "alert");
    const fields = element("div", "wtr-pattern-inputs");
    fields.append(
      ...patternFields(pattern, {
        baseMeans: "the base rate",
        refuse: (message) => {
          error.textContent = message;
        },
        apply: (next) => {
          update(setPattern(doc, next));
          return true;
        },
      }),
    );

    const summary = element("p", "wtr-pattern-note");
    summary.dataset["patternSummary"] = "";
    const laid = patternSegments(pattern, doc.load[0]?.rate ?? 0, { from: 0, seed: doc.seed, limit: Infinity });
    if (laid.ok) summary.textContent = summarizePattern(laid);

    loadPanel.append(baseRow, fields, summary, error);
  };

  // ------------------------------------------------------------ assumptions
  /**
   * Every core number nobody has confirmed, in one list. Before a review it is
   * the checklist of numbers somebody will challenge; after, the ones to go and
   * measure.
   */
  const renderAssumptions = (): void => {
    assumptions.replaceChildren();
    const rows: HTMLElement[] = [];
    for (const component of doc.components) {
      for (const field of coreFields(component)) {
        if (field.control === "select" || provenanceOf(component, field.key) !== "assumed") continue;
        const row = element("li", "wtr-assumption");
        const open = button(
          `${component.id}: ${field.noun} ${field.value(component.spec)}${field.unit === undefined ? "" : ` ${field.unit}`}`,
          `assumption:${component.id}:${field.key}`,
          "wtr-link",
        );
        open.addEventListener("click", () => {
          selected = { kind: "component", id: component.id };
          render();
        });
        const confirm = button("Confirm", `confirm:${component.id}:${field.key}`, "wtr-button wtr-button-small");
        confirm.title = "Somebody has stated this number.";
        confirm.addEventListener("click", () => update(setProvenance(doc, component.id, field.key, "stated")));
        row.append(open, confirm);
        rows.push(row);
      }
    }

    const details = element("details", "wtr-details");
    details.dataset["section"] = "assumptions";
    details.append(
      element(
        "summary",
        "wtr-details-summary",
        rows.length === 0 ? "Guesses: none" : `Guesses: ${rows.length} ${rows.length === 1 ? "number" : "numbers"} nobody has confirmed`,
      ),
    );
    if (rows.length > 0) {
      const list = element("ul", "wtr-assumption-list");
      list.append(...rows);
      details.append(list);
    } else {
      details.append(element("p", "wtr-preset-note", "Every number in this model has been stated or measured."));
    }
    assumptions.append(details);
  };

  // --------------------------------------------------------------- problems
  const renderProblems = (): void => {
    const validation = validateDocument(doc);
    problems.replaceChildren();
    problems.dataset["problems"] = validation.ok ? "0" : String(validation.errors.length);
    runButton.disabled = !validation.ok;
    runButton.title = validation.ok ? "Run this model" : "Fix the problems marked on the canvas first.";

    if (fileMessage !== "") problems.append(element("p", "wtr-file-message", fileMessage));
    if (validation.ok) return;

    const list = element("ul", "wtr-problem-list");
    for (const problem of validation.errors) list.append(element("li", undefined, problem));
    problems.append(list);
  };

  // ---------------------------------------------------------------- chooser
  const renderChooser = (): void => {
    chooser.dataset["chooser"] = chooserOpen ? "open" : "closed";
    chooser.replaceChildren();
    if (!chooserOpen) return;

    const head = element("div", "wtr-chooser-head");
    head.append(element("h2", "wtr-panel-title", "Start from"));
    const close = button("Cancel", "close-chooser", "wtr-button wtr-button-small");
    close.addEventListener("click", () => {
      chooserOpen = false;
      render();
    });
    head.append(close);
    chooser.append(head);

    const grid = element("div", "wtr-chooser-grid");
    for (const shape of STARTING_SHAPES) {
      const card = button("", `shape:${shape.id}`, "wtr-shape");
      card.append(element("strong", undefined, shape.label), element("span", undefined, shape.blurb));
      card.addEventListener("click", () => {
        chooserOpen = false;
        selected = null;
        connectingFrom = null;
        fileMessage = "Started a new model. Undo brings the previous one back.";
        const started = shape.build();
        update(started);
        options.onClean?.(started);
      });
      grid.append(card);
    }
    chooser.append(grid);
  };

  // ------------------------------------------------------------------ paint
  const decorations = (): Decorations => {
    const kindLabels = new Map(doc.components.map((component) => [component.id, labelOf(component)]));
    return {
      selectedNode: selected?.kind === "component" ? selected.id : connectingFrom,
      selectedEdge: selected?.kind === "edge" ? { from: selected.from, to: selected.to } : null,
      problems: problemsByComponent(doc),
      kindLabels,
      assumed: whollyAssumed(doc),
      dragLine,
    };
  };

  const paint = (): void => renderer?.paint(frame, decorations());

  const render = (): void => {
    nameInput.value = doc.name;
    frame = emptyFrame(toTimeline(doc).model);
    undoButton.disabled = past.length === 0;
    redoButton.disabled = future.length === 0;

    hint.textContent =
      connectingFrom !== null
        ? `Click the box ${connectingFrom} sends requests to, or press Escape.`
        : doc.components.length === 0
          ? "Add a component from the palette, or start from a common shape with New…"
          : "Drag from a box to the box it sends requests to. Click a box or an arrow to change it.";
    hint.dataset["hint"] = connectingFrom === null ? "" : "wiring";

    renderPalette();
    renderInspector();
    renderLoad();
    renderAssumptions();
    renderProblems();
    renderChooser();
    paint();
  };

  // ----------------------------------------------------------------- events
  const connectTo = (from: string, to: string): void => {
    const exists = doc.edges.some((edge) => edge.from === from && edge.to === to);
    connectingFrom = null;
    if (exists || from === to) {
      selected = exists ? { kind: "edge", from, to } : selected;
      render();
      return;
    }
    // The new arrow is selected straight away, so the next thing the author sees
    // is the question about what it means — the default is a guess, said out loud.
    selected = { kind: "edge", from, to };
    update(connect(doc, from, to, defaultEdgeKind(doc, from)));
  };

  /** A drag that ended on a box connects; set on pointerdown, cleared on up. */
  let dragFrom: { id: string; x: number; y: number } | null = null;
  let dragged = false;
  /** A drag ends with a click event too; this swallows it. */
  let swallowClick = false;

  const onPointerDown = (event: PointerEvent): void => {
    const id = renderer?.nodeAt(event, frame) ?? null;
    if (id === null || renderer === null) return;
    const at = renderer.toLayout(event, frame);
    dragFrom = { id, x: at.x, y: at.y };
    dragged = false;
  };

  const onPointerMove = (event: PointerEvent): void => {
    if (dragFrom === null || renderer === null) return;
    const at = renderer.toLayout(event, frame);
    if (!dragged && Math.hypot(at.x - dragFrom.x, at.y - dragFrom.y) < 8) return;
    dragged = true;
    const place = frame.nodes.find((node) => node.id === dragFrom?.id)?.place;
    if (place === undefined) return;
    dragLine = { x1: place.x + place.w, y1: place.y + place.h / 2, x2: at.x, y2: at.y };
    paint();
  };

  const onPointerUp = (event: PointerEvent): void => {
    if (dragFrom === null) return;
    const from = dragFrom.id;
    const wasDrag = dragged;
    dragFrom = null;
    dragged = false;
    dragLine = null;
    if (!wasDrag) return;
    swallowClick = true;
    const target = renderer?.nodeAt(event, frame) ?? null;
    if (target !== null && target !== from) connectTo(from, target);
    else paint();
  };

  const onCanvasClick = (event: MouseEvent): void => {
    if (swallowClick) {
      swallowClick = false;
      return;
    }
    const id = renderer?.nodeAt(event, frame) ?? null;
    if (id !== null) {
      if (connectingFrom !== null && connectingFrom !== id) {
        connectTo(connectingFrom, id);
        return;
      }
      connectingFrom = null;
      selected = { kind: "component", id };
      render();
      return;
    }

    connectingFrom = null;
    const edge = renderer?.edgeAt(event, frame) ?? null;
    selected = edge === null ? null : { kind: "edge", from: edge.from, to: edge.to };
    render();
  };

  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === "Escape") {
      if (connectingFrom !== null || chooserOpen) {
        connectingFrom = null;
        chooserOpen = false;
        render();
      }
      return;
    }
    // Not while typing: Ctrl+Z in a field is the field's own undo.
    const typing = event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement;
    if (typing || !(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== "z") return;
    event.preventDefault();
    if (event.shiftKey) redo();
    else undo();
  };

  nameInput.addEventListener("change", () => update(setName(doc, nameInput.value)));
  newButton.addEventListener("click", () => {
    chooserOpen = !chooserOpen;
    render();
  });
  undoButton.addEventListener("click", undo);
  redoButton.addEventListener("click", redo);

  saveButton.addEventListener("click", () => {
    const blob = new Blob([serialize(doc)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = element("a");
    anchor.href = url;
    anchor.download = suggestedFilename(doc);
    anchor.click();
    URL.revokeObjectURL(url);
    fileMessage = `Saved as ${suggestedFilename(doc)}.`;
    options.onClean?.(doc);
    renderProblems();
  });

  const openText = (text: string): void => {
    const result = parse(text);
    if (!result.ok) {
      // The editor keeps what it had rather than half of somebody else's file.
      fileMessage = `${result.error} Nothing was changed.`;
      renderProblems();
      return;
    }
    selected = null;
    connectingFrom = null;
    fileMessage = `Opened ${result.document.name}. Undo brings the previous model back.`;
    update(result.document);
    options.onClean?.(result.document);
  };

  openInput.addEventListener("change", () => {
    const file = openInput.files?.[0];
    if (file === undefined) return;
    void file.text().then(openText);
    // Cleared so opening the same file twice in a row still fires a change.
    openInput.value = "";
  });

  const onDragOver = (event: DragEvent): void => event.preventDefault();
  const onDrop = (event: DragEvent): void => {
    event.preventDefault();
    const file = event.dataTransfer?.files?.[0];
    if (file === undefined) return;
    void file.text().then(openText);
  };

  runButton.addEventListener("click", () => {
    if (!validateDocument(doc).ok) return;
    options.onRun(doc);
  });

  return {
    element: root,

    start() {
      renderer = createRenderer(canvas);
      canvas.addEventListener("click", onCanvasClick);
      canvas.addEventListener("pointerdown", onPointerDown);
      globalThis.addEventListener("pointermove", onPointerMove);
      globalThis.addEventListener("pointerup", onPointerUp);
      root.addEventListener("dragover", onDragOver);
      root.addEventListener("drop", onDrop);
      globalThis.addEventListener("keydown", onKeyDown);
      render();
    },

    document: () => doc,

    destroy() {
      canvas.removeEventListener("click", onCanvasClick);
      canvas.removeEventListener("pointerdown", onPointerDown);
      globalThis.removeEventListener("pointermove", onPointerMove);
      globalThis.removeEventListener("pointerup", onPointerUp);
      root.removeEventListener("dragover", onDragOver);
      root.removeEventListener("drop", onDrop);
      globalThis.removeEventListener("keydown", onKeyDown);
      renderer?.destroy();
      renderer = null;
    },
  };
}
