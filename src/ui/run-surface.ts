/**
 * The run surface: the model running, and the controls that steer it live.
 *
 * Everything here is built around one constraint from the origin — the driver is
 * changing things *while a room watches*. So there is no edit-and-rerun anywhere:
 * dragging the load or picking a different policy takes effect in the simulation
 * that is already running (R7), by appending to the recorded timeline rather than
 * by restarting anything. The session stays replayable afterwards because the log
 * the live controls write is the same log a replay reads.
 *
 * There is deliberately no scrubber. Sim time only moves forward; rewinding means
 * replaying a recorded timeline, which is a different mode and would invite the
 * driver to fiddle with the past mid-argument.
 *
 * `data-action` and `data-surface` attributes are the automation contract the
 * browser tests drive, lifted from the prior art.
 */
import type { Simulation } from "../engine/kernel.ts";
import type { Timeline } from "../engine/timeline.ts";
import { createModelSimulation } from "../specs/registry.ts";
import { frameFor } from "../view/frame.ts";
import { computeViewport, createRenderer, type Renderer } from "../view/renderer.ts";
import { createPlayer, type Player } from "../view/player.ts";
import type { PartialComponentSpec } from "../specs/format.ts";
import { capacityOf, describeCapacity, parseCapacity, withCapacity } from "../specs/capacity.ts";
import { describeTimeout, parseTimeout, timeoutOf, withTimeout } from "../specs/timeout.ts";
import {
  describeCallPolicy,
  parseRetries,
  resolveCallPolicy,
  withCallRetries,
  withCallTimeout,
  type PartialCallPolicy,
} from "../specs/call-policy.ts";
import { callKey } from "../engine/timeline.ts";
import type { PresetControl, RunControls } from "./controls.ts";
import type { Guidance } from "./demo.ts";
import { createValidationPanel, type ValidationPanel } from "./validation-panel.ts";
import { createVerdictPanel, type VerdictPanel } from "./verdict-panel.ts";
import type { SweepTarget } from "../verdict/sweep.ts";
import { PATTERN_LABELS, patternFields } from "./pattern-fields.ts";
import type { RunChanges } from "../model/keep.ts";
import {
  DEFAULT_PATTERNS,
  PATTERN_LIMIT_FACTOR,
  describePattern,
  patternSegments,
  summarizePattern,
  type LoadPattern,
  type PatternKind,
  type PatternResult,
} from "../model/load-pattern.ts";
import { baselineOf, NO_COMPARISON, type ComparisonSpec } from "../verdict/study.ts";

export interface RunSurface {
  element: HTMLElement;
  /** Starts the loop. Separate from construction so the canvas has a layout box. */
  start(): void;
  /** The simulation on screen. Changes identity on a clean rerun. */
  simulation(): Simulation;
  destroy(): void;
}

const SPEEDS = [0.5, 1, 2, 4];

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

function readout(label: string): { root: HTMLElement; value: HTMLElement } {
  const root = element("div", "wtr-readout");
  const value = element("strong", "wtr-readout-value", "—");
  root.append(value, element("span", "wtr-readout-label", label));
  return { root, value };
}

export interface RunOptions {
  /** Offered when the model came from, or can go to, the editor. */
  onEdit?: () => void;
  /**
   * What this design is being compared against: the components marked as this
   * month's proposal, and the one parameter under dispute (R9, R10).
   *
   * Passed rather than read off a document, because the model that runs here is
   * the authored one plus every knob turned since. Two sources of truth for
   * "what is running" is how a verdict ends up describing a different system
   * from the one on screen.
   */
  comparison?: ComparisonSpec;
  /**
   * What to tell a viewer who opened this file with nobody presenting (F3).
   *
   * Only the demo supplies one. A model somebody authored themselves needs no
   * tour — they know what they drew, and a panel explaining their own system back
   * to them would be the tool talking down to its user.
   */
  guidance?: Guidance;
  /**
   * What to print under each component's name — "Database", "In-memory store" —
   * where the author's word for it says more than the engine's kind.
   */
  labels?: ReadonlyMap<string, string>;
  /** Components whose numbers are all still guesses, marked as such on the box. */
  assumed?: ReadonlySet<string>;
  /**
   * Write the run's current settings back into the model ("Keep these changes").
   * Offered only when there is a model to write them into.
   */
  onKeep?: (changes: RunChanges) => void;
}

export function createRunSurface(
  initialSim: Simulation,
  controls: RunControls,
  options: RunOptions = {},
): RunSurface {
  const root = element("section", "wtr-run-surface");
  root.dataset["surface"] = "run";

  // Replaced wholesale by a clean rerun, so every closure below reads the
  // variable rather than capturing the simulation it was built with.
  let sim = initialSim;

  const comparison = options.comparison ?? NO_COMPARISON;

  /**
   * The model as authored, kept whatever is on screen.
   *
   * Showing the baseline replaces the running model with a smaller one, and every
   * later question — rerun, sweep, switch back — is about the *authored* design,
   * not about whichever arm happens to be running. Deriving it from the live
   * simulation instead would mean the proposal quietly ceased to exist the first
   * time somebody looked at the baseline.
   */
  const authored = initialSim.recorded().model;
  let showing: "proposal" | "baseline" = "proposal";

  /**
   * Whether what is on screen has been steered mid-run, and from when.
   *
   * A live model carries its own history: a queue that filled at 44/s is still
   * full after the capacity is raised, and the retries that filled it are still
   * arriving. That is a true and important thing to be able to show — systems
   * really do fail to recover from a change that would have prevented the
   * failure. It is also a reading that answers a *different question* from "what
   * would this design do", and the two are easy to confuse in a room.
   *
   * So the surface never silently resolves it. It marks the reading as steered
   * and offers the other question as one click.
   */
  let steeredFrom: number | null = null;

  /**
   * Each node's authored spec as it stands right now.
   *
   * A `set-spec` mutation replaces a node's spec wholesale in the kernel, so
   * every control has to send a complete one. With two controls on the same
   * component — a policy dropdown and a capacity field — sending only what that
   * control governs would silently revert the other. So the surface holds the
   * merged truth, each control contributes its own concerns, and what goes into
   * the recorded log is the whole spec the model is running.
   */
  const specs = new Map<string, PartialComponentSpec>(
    sim.recorded().model.nodes.map((node) => [node.id, node.spec as PartialComponentSpec]),
  );

  // Copies the run's settings into the model. Live changes are experiments until
  // the driver says otherwise, so it is a button and never automatic, and it
  // stays disabled until there is something to keep.
  const keep = element("button", "wtr-button", "Keep these changes");
  keep.type = "button";
  keep.dataset["action"] = "keep";
  keep.disabled = true;
  keep.title = "Make the settings on this screen part of the model, so Edit model and Save carry them.";

  const markSteered = (): void => {
    keep.disabled = false;
    keep.textContent = "Keep these changes";
    // A breaking point already on screen was worked out for the design as it was
    // a moment ago, so any change makes it a claim about a different system.
    verdict?.markStale();
    if (steeredFrom === null) steeredFrom = sim.now();
    steeredBadge.dataset["steered"] = "true";
    steeredBadge.textContent =
      `Steered at ${steeredFrom.toFixed(1)}s — these numbers include how it got here. ` +
      "Rerun clean to ask what this design does from cold.";
  };

  const applySpec = (nodeId: string, patch: PartialComponentSpec): PartialComponentSpec => {
    const merged = { ...(specs.get(nodeId) ?? {}), ...patch };
    specs.set(nodeId, merged);
    sim.record({ kind: "set-spec", nodeId, spec: merged as Record<string, unknown> });
    markSteered();
    return merged;
  };

  // ------------------------------------------------------------- readouts
  const offered = readout("offered");
  const goodput = readout("completing");
  const dropped = readout("lost");
  const latency = readout("p95 latency");
  const inFlight = readout("in flight");

  const steeredBadge = element("p", "wtr-steered");
  steeredBadge.dataset["steered"] = "false";

  // Names the component that started the trouble, because the canvas alone
  // cannot: trouble propagates backwards, so one saturated component reddens
  // everything in front of it and the picture accuses the innocent along with
  // the guilty. Without this the room argues about the wrong box.
  const culpritLine = element("p", "wtr-culprit");
  culpritLine.dataset["culprit"] = "";

  // Only ever used by the baseline switch, which is the one control here that can
  // fail: a proposal can be marked such that taking it out leaves no runnable
  // model, and the honest answer is to say so and keep showing what was working.
  const armError = element("p", "wtr-arm-error");
  armError.setAttribute("role", "alert");

  const alerts = element("div", "wtr-alerts");
  alerts.append(culpritLine, steeredBadge, armError);

  const stats = element("div", "wtr-stats");
  stats.append(offered.root, goodput.root, dropped.root, latency.root, inFlight.root);

  // ---------------------------------------------------------------- canvas
  const stage = element("div", "wtr-stage");
  const canvas = element("canvas", "wtr-canvas");
  // In Present mode the selected component's knobs float here, beside its box,
  // so the driver's hand and the room's eye are in the same place.
  const steerCard = element("div", "wtr-steer-card");
  steerCard.dataset["card"] = "empty";
  stage.append(canvas, steerCard);

  // ------------------------------------------------------------- transport
  const playPause = element("button", "wtr-button wtr-button-primary", "Pause");
  playPause.type = "button";
  playPause.dataset["action"] = "play-pause";

  const speed = element("select", "wtr-select");
  speed.dataset["action"] = "speed";
  speed.setAttribute("aria-label", "Playback speed");
  for (const value of SPEEDS) {
    const option = element("option", undefined, `${value}×`);
    option.value = String(value);
    if (value === 1) option.selected = true;
    speed.append(option);
  }

  const loadInput = element("input", "wtr-slider");
  loadInput.type = "range";
  loadInput.min = String(controls.load.min);
  loadInput.max = String(controls.load.max);
  loadInput.step = String(controls.load.step);
  loadInput.value = String(controls.load.base);
  loadInput.dataset["action"] = "load";
  loadInput.setAttribute("aria-label", "Offered load, requests per second");

  const loadValue = element("span", "wtr-slider-value", `${controls.load.base}/s`);
  const loadField = element("label", "wtr-field");
  loadField.append(element("span", "wtr-field-label", "Load"), loadInput, loadValue);

  // The shape of the load over time. The slider stays the number being argued
  // about (the rate between spikes, the average, or the first step); the pattern
  // says how the load moves around it. It starts as the model's saved pattern.
  // Each kind remembers its last settings, so flipping to steady and back to
  // spiky does not throw away the spikes somebody typed.
  const patterns: { [K in PatternKind]: Extract<LoadPattern, { kind: K }> } = { ...DEFAULT_PATTERNS };
  let pattern: LoadPattern = controls.load.pattern ?? patterns.steady;
  (patterns as Record<PatternKind, LoadPattern>)[pattern.kind] = pattern;

  const patternSelect = element("select", "wtr-select");
  patternSelect.dataset["action"] = "pattern";
  patternSelect.setAttribute("aria-label", "Load pattern");
  for (const kind of Object.keys(PATTERN_LABELS) as PatternKind[]) {
    // Steps are typed in the editor, so they are offered here only when the model
    // came with them: there is no schedule to switch to otherwise.
    if (kind === "steps" && pattern.kind !== "steps") continue;
    const option = element("option", undefined, PATTERN_LABELS[kind]);
    option.value = kind;
    patternSelect.append(option);
  }
  patternSelect.value = pattern.kind;
  const patternField = element("label", "wtr-field");
  patternField.append(element("span", "wtr-field-label", "Pattern"), patternSelect);

  // The pattern's own settings, the sentence saying what they add up to, and any
  // refusal. A full-width line under the transport, so a long formula has room.
  const patternRow = element("div", "wtr-pattern");
  patternRow.dataset["pattern"] = "steady";
  const patternInputs = element("div", "wtr-pattern-inputs");
  const patternSummary = element("p", "wtr-pattern-note");
  patternSummary.dataset["patternSummary"] = "";
  const patternError = element("p", "wtr-pattern-error");
  patternError.setAttribute("role", "alert");
  patternRow.append(patternInputs, patternSummary, patternError);

  const validate = element("button", "wtr-button", "Why trust this?");
  validate.title = "The simulator against queueing theory's textbook answers, run here and now.";
  validate.type = "button";
  validate.dataset["action"] = "validation";

  const breakingPoint = element("button", "wtr-button", "Breaking point");
  breakingPoint.type = "button";
  breakingPoint.dataset["action"] = "sweep";
  breakingPoint.title =
    "Run this design headless at one steady rate after another to bracket the load it stops holding.";

  const rerun = element("button", "wtr-button", "Rerun clean");
  rerun.type = "button";
  rerun.dataset["action"] = "rerun";
  rerun.title = "Run this design from cold: same parameters, same load, same seed, empty queues.";

  const armToggle = element("div", "wtr-arm-toggle");
  const armButtons = new Map<"proposal" | "baseline", HTMLButtonElement>();
  if (comparison.delta.length > 0) {
    armToggle.dataset["showing"] = "proposal";
    for (const arm of ["proposal", "baseline"] as const) {
      const button = element("button", "wtr-button wtr-button-small", arm === "proposal" ? "With proposal" : "Without it");
      button.type = "button";
      button.dataset["action"] = `arm:${arm}`;
      armButtons.set(arm, button);
      armToggle.append(button);
    }
  }

  // Present mode: the canvas and the knob being argued about, nothing else. One
  // surface with two layouts rather than two surfaces, so the room sees exactly
  // the run the driver was steering.
  const present = element("button", "wtr-button", "Present");
  present.type = "button";
  present.dataset["action"] = "present";
  present.title = "Full-width canvas for a shared screen. Click a box to steer it.";

  const transport = element("div", "wtr-transport");
  transport.append(playPause, speed, loadField, patternField, rerun, armToggle, breakingPoint, present, validate);
  if (options.onKeep !== undefined) transport.append(keep);

  if (options.onEdit !== undefined) {
    const edit = element("button", "wtr-button", "Edit model");
    edit.type = "button";
    edit.dataset["action"] = "edit";
    edit.addEventListener("click", () => options.onEdit?.());
    transport.append(edit);
  }
  transport.append(patternRow);

  // --------------------------------------------------------------- presets
  const presetRow = element("div", "wtr-presets");
  const notes = new Map<PresetControl, HTMLElement>();

  for (const control of controls.presets) {
    const select = element("select", "wtr-select");
    select.dataset["action"] = `preset:${control.label.toLowerCase().replace(/\s+/g, "-")}`;
    select.setAttribute("aria-label", control.label);
    for (const option of control.options) {
      const item = element("option", undefined, option.label);
      item.value = option.value;
      if (option.value === control.initial) item.selected = true;
      select.append(item);
    }

    const note = element("p", "wtr-preset-note");
    const initial = control.options.find((option) => option.value === control.initial);
    note.textContent = initial?.note ?? "";
    notes.set(control, note);

    select.addEventListener("change", () => {
      const chosen = control.options.find((option) => option.value === select.value);
      if (chosen === undefined) return;
      // Applied to the running simulation, one mutation per affected node.
      for (const nodeId of control.nodeIds) applySpec(nodeId, chosen.spec);
      note.textContent = chosen.note;
      logChange(`${control.label} → ${chosen.label}`);
      refreshCapacities();
      player?.repaint();
    });

    const field = element("label", "wtr-field");
    field.append(element("span", "wtr-field-label", control.label), select);

    const group = element("div", "wtr-preset-group");
    group.append(field, note);
    presetRow.append(group);
  }

  // ---------------------------------------------------------- typed parameters
  //
  // Capacity and timeout are the same control with different arithmetic behind
  // it, so they share a renderer: a text field, the conversion printed under it,
  // and an error that leaves the model running on the value it already had.
  //
  // Text fields rather than sliders. These are claims somebody is making about a
  // real system, usually read off a dashboard, and they deserve to be typed
  // exactly. The one slider on this surface stays the load, which is a thing you
  // drag.
  interface TypedField {
    nodeIds: string[];
    /** `data-action` prefix, and the namespace for the conversion line. */
    action: string;
    label: string;
    /** Shown after the input, and in the field's accessible name. */
    unit: string;
    note: string;
    /** Current value and its explanation, or `null` if this kind has neither. */
    read: (spec: PartialComponentSpec) => { value: string; description: string } | null;
    apply: (
      spec: PartialComponentSpec,
      text: string,
    ) => { ok: true; spec: PartialComponentSpec } | { ok: false; error: string };
  }

  const paramRow = element("div", "wtr-presets wtr-steer-list");
  const paramRefreshers: Array<() => void> = [];

  /**
   * One section per component, holding every knob that steers it.
   *
   * A model of any size has more knobs than a room can scan, and the one being
   * argued about is nearly always on the box somebody just pointed at — or on the
   * box that folded first. So each component's knobs sit together, closed until
   * that component is clicked on the canvas or starts the trouble.
   */
  interface Section {
    element: HTMLDetailsElement;
    body: HTMLElement;
    nodeIds: readonly string[];
  }
  const sections: Section[] = [];

  const sectionFor = (nodeIds: readonly string[]): HTMLElement => {
    const key = nodeIds.join(" ");
    let section = sections.find((candidate) => candidate.nodeIds.join(" ") === key);
    if (section === undefined) {
      const details = element("details", "wtr-steer");
      details.dataset["steer"] = key;
      const summary = element("summary", "wtr-steer-summary");
      summary.append(element("strong", undefined, nodeIds.join(", ")));
      const first = nodeIds[0];
      const kind = first === undefined ? undefined : options.labels?.get(first);
      if (kind !== undefined) summary.append(element("span", "wtr-panel-kind", kind));
      const body = element("div", "wtr-steer-body");
      details.append(summary, body);
      paramRow.append(details);
      section = { element: details, body, nodeIds };
      sections.push(section);
    }
    return section.body;
  };

  // ------------------------------------------------------------- change log
  //
  // Every live change, as a chip a room can read: what was turned, to what, and
  // when. The recorded mutation log is the replayable truth; this is the same
  // history said in words, so "what did we change?" has an answer on screen.
  const changeList = element("ol", "wtr-changes");
  changeList.setAttribute("aria-label", "Changes made while running");
  const changeLog: Array<{ at: number; text: string; load: boolean }> = [];

  const renderChanges = (): void => {
    changeList.replaceChildren(
      ...changeLog.map((change) => {
        const chip = element("li", "wtr-change", `${change.at.toFixed(0)} s · ${change.text}`);
        return chip;
      }),
    );
  };

  const logChange = (text: string, load = false): void => {
    // A drag is one change, not sixty: consecutive load moves collapse to the last.
    const last = changeLog[changeLog.length - 1];
    if (load && last?.load === true) changeLog.pop();
    changeLog.push({ at: sim.now(), text, load });
    renderChanges();
  };

  const addField = (field: TypedField): void => {
    const first = field.nodeIds[0];
    if (first === undefined || field.read(specs.get(first) ?? {}) === null) return;

    const input = element("input", "wtr-number");
    input.type = "text";
    input.inputMode = "decimal";
    input.dataset["action"] = `${field.action}:${first}`;
    input.setAttribute("aria-label", `${field.label}, ${field.unit}`);

    const note = element("p", "wtr-preset-note", field.note);
    const conversion = element("p", "wtr-conversion");
    conversion.dataset["conversion"] = `${field.action}:${first}`;
    const error = element("p", "wtr-field-error");
    error.setAttribute("role", "alert");

    const refresh = (): void => {
      const reading = field.read(specs.get(first) ?? {});
      if (reading === null) return;
      input.value = reading.value;
      conversion.textContent = reading.description;
    };
    refresh();
    paramRefreshers.push(refresh);

    input.addEventListener("change", () => {
      // Applied to every node the control covers, but parsed once: a control
      // that half-applied would leave two replicas disagreeing.
      const parsed = field.apply(specs.get(first) ?? {}, input.value);
      if (!parsed.ok) {
        // The model keeps running on the value it already had. Silently snapping
        // to a bound would leave the panel showing one number and the simulation
        // obeying another, which is the one failure this tool cannot afford.
        error.textContent = parsed.error;
        return;
      }
      error.textContent = "";
      // A change event also fires when focus leaves a field that was already
      // applied; recording that again would put a no-op in the replay log and a
      // duplicate chip on screen.
      const unchanged = field.nodeIds.every((nodeId) => {
        const applied = field.apply(specs.get(nodeId) ?? {}, input.value);
        return applied.ok && JSON.stringify(applied.spec) === JSON.stringify(specs.get(nodeId) ?? {});
      });
      if (unchanged) return;
      for (const nodeId of field.nodeIds) {
        const applied = field.apply(specs.get(nodeId) ?? {}, input.value);
        if (applied.ok) applySpec(nodeId, applied.spec);
      }
      refresh();
      logChange(`${field.label} → ${input.value.trim()}${/^[0-9.]+$/.test(input.value.trim()) ? ` ${field.unit}` : ""}`);
      player?.repaint();
    });

    const label = element("label", "wtr-field");
    label.append(element("span", "wtr-field-label", field.label), input, element("span", "wtr-field-unit", field.unit));

    const group = element("div", "wtr-preset-group");
    group.append(label, conversion, note, error);
    sectionFor(field.nodeIds).append(group);
  };

  for (const control of controls.capacities) {
    addField({
      nodeIds: control.nodeIds,
      action: "capacity",
      label: control.label,
      unit: "/s",
      note: control.note,
      read: (spec) => {
        const reading = capacityOf(control.kind, spec);
        if (reading === null) return null;
        // A control covering several replicas states the figure PER replica and
        // applies it to each, so the fleet total is spelled out rather than left
        // as arithmetic for the reader — that arithmetic is exactly where somebody
        // concludes "two at 25 covers 40" and stops looking for the real limit.
        const fleet =
          control.nodeIds.length > 1 && Number.isFinite(reading.perSecond)
            ? ` · ×${control.nodeIds.length} replicas = ${Number((reading.perSecond * control.nodeIds.length).toFixed(2))}/s offered capacity`
            : "";
        return {
          value: Number.isFinite(reading.perSecond) ? String(Number(reading.perSecond.toFixed(2))) : "",
          description: `${describeCapacity(reading)}${fleet}`,
        };
      },
      apply: (spec, text) => {
        const parsed = parseCapacity(text);
        return parsed.ok
          ? { ok: true, spec: withCapacity(control.kind, spec, parsed.perSecond) }
          : { ok: false, error: parsed.error };
      },
    });
  }

  for (const control of controls.timeouts) {
    addField({
      nodeIds: control.nodeIds,
      action: "timeout",
      label: control.label,
      unit: "ms",
      note: control.note,
      read: (spec) => {
        const reading = timeoutOf(control.kind, spec);
        if (reading === null) return null;
        return {
          value: reading.policy === "none" ? "off" : String(Number(reading.milliseconds.toFixed(2))),
          description: describeTimeout(reading),
        };
      },
      apply: (spec, text) => {
        const parsed = parseTimeout(text);
        return parsed.ok
          ? { ok: true, spec: withTimeout(control.kind, spec, parsed.milliseconds) }
          : { ok: false, error: parsed.error };
      },
    });
  }

  // --------------------------------------------------------- other traffic
  //
  // A text field, for the same reason capacity is one: this is a number read off
  // somebody's dashboard, not a thing to drag. It records a `set-source-rate`
  // rather than a spec change, because other traffic is not a property of the
  // component — the component does not know who is calling it.
  const sourceRates = new Map(controls.traffic.map((control) => [control.sourceId, control.base]));
  for (const control of controls.traffic) {
    const input = element("input", "wtr-number");
    input.type = "text";
    input.inputMode = "decimal";
    input.dataset["action"] = `traffic:${control.sourceId}`;
    input.setAttribute("aria-label", `${control.label}, per second`);
    input.value = String(control.base);

    const error = element("p", "wtr-field-error");
    error.setAttribute("role", "alert");

    input.addEventListener("change", () => {
      const rate = Number(input.value.trim());
      if (!Number.isFinite(rate) || rate < 0) {
        // The run keeps the rate it already had: a field showing one number
        // while the simulation obeys another is the one failure to avoid.
        error.textContent = "Other traffic has to be zero or more requests per second.";
        return;
      }
      error.textContent = "";
      sim.record({ kind: "set-source-rate", sourceId: control.sourceId, rate });
      sourceRates.set(control.sourceId, rate);
      markSteered();
      logChange(`${control.label} → ${rate}/s`);
      player?.repaint();
    });

    const label = element("label", "wtr-field");
    label.append(element("span", "wtr-field-label", control.label), input, element("span", "wtr-field-unit", "/s"));

    const group = element("div", "wtr-preset-group");
    group.append(label, element("p", "wtr-preset-note", control.note), error);
    sectionFor([control.nodeId]).append(group);
  }

  // ------------------------------------------------------- dependency calls
  //
  // A call's timeout and retry, as two typed fields and one sentence. It records
  // a `set-call` rather than a spec change, because the policy belongs to the
  // call and not to either component. Like a spec, the kernel replaces a call's
  // policy wholesale, so the surface holds the merged truth and each field
  // contributes its own half — otherwise turning retries off would silently put
  // the timeout back.
  const callPolicies = new Map<string, PartialCallPolicy>(
    sim
      .recorded()
      .model.edges.filter((edge) => edge.kind === "call")
      .map((edge) => [callKey(edge.from, edge.to), (edge.policy ?? {}) as PartialCallPolicy]),
  );

  /**
   * Edges carrying each call's policy as it stands now.
   *
   * What `specs` does for components, for calls: a clean rerun and a sweep both
   * ask about the design *as currently set*, and a rerun that quietly put back the
   * retry somebody just turned off would answer a question nobody asked.
   */
  const withLiveCalls = (edges: Timeline["model"]["edges"]): Timeline["model"]["edges"] =>
    edges.map((edge) => {
      if (edge.kind !== "call") return edge;
      const policy = callPolicies.get(callKey(edge.from, edge.to));
      if (policy === undefined) return edge;
      const { policy: _authored, ...rest } = edge;
      return Object.keys(policy).length === 0 ? rest : { ...rest, policy: policy as Record<string, unknown> };
    });

  for (const control of controls.calls) {
    const key = callKey(control.from, control.to);
    const current = (): PartialCallPolicy => callPolicies.get(key) ?? {};

    const description = element("p", "wtr-conversion", describeCallPolicy(current()));
    description.dataset["conversion"] = `call:${control.from}:${control.to}`;
    const error = element("p", "wtr-field-error");
    error.setAttribute("role", "alert");

    const apply = (next: PartialCallPolicy, said: string): void => {
      error.textContent = "";
      callPolicies.set(key, next);
      sim.record({ kind: "set-call", from: control.from, to: control.to, policy: next as Record<string, unknown> });
      description.textContent = describeCallPolicy(next);
      markSteered();
      logChange(`${control.label} ${said}`);
      player?.repaint();
    };

    const resolved = resolveCallPolicy(current());

    const timeout = element("input", "wtr-number wtr-number-small");
    timeout.type = "text";
    timeout.inputMode = "decimal";
    timeout.dataset["action"] = `call-timeout:${control.from}:${control.to}`;
    timeout.setAttribute("aria-label", `${control.label} timeout, ms`);
    timeout.value =
      resolved.timeout.policy === "none" ? "off" : String(Number((resolved.timeout.after * 1000).toFixed(2)));
    timeout.addEventListener("change", () => {
      const parsed = parseTimeout(timeout.value);
      // The run keeps the policy it already had, as every field here does.
      if (!parsed.ok) error.textContent = parsed.error;
      else apply(withCallTimeout(current(), parsed.milliseconds), `timeout → ${parsed.milliseconds === null ? "off" : `${parsed.milliseconds} ms`}`);
    });

    const retries = element("input", "wtr-number wtr-number-small");
    retries.type = "text";
    retries.inputMode = "numeric";
    retries.dataset["action"] = `call-retries:${control.from}:${control.to}`;
    retries.setAttribute("aria-label", `${control.label} retries`);
    retries.value = resolved.retry.policy === "none" ? "off" : String(resolved.retry.attempts);
    retries.addEventListener("change", () => {
      const parsed = parseRetries(retries.value);
      if (!parsed.ok) error.textContent = parsed.error;
      else apply(withCallRetries(current(), parsed.attempts), `retries → ${parsed.attempts === null ? "off" : parsed.attempts}`);
    });

    // The name on its own line: a call is named by both its ends, which is
    // already most of the column before either field is drawn.
    const fields = element("div", "wtr-call-fields");
    fields.append(
      timeout,
      element("span", "wtr-field-unit", "ms timeout"),
      retries,
      element("span", "wtr-field-unit", "retries"),
    );

    const group = element("div", "wtr-preset-group");
    group.append(
      element("span", "wtr-field-label", control.label),
      fields,
      description,
      element("p", "wtr-preset-note", control.note),
      error,
    );
    sectionFor([control.from]).append(group);
  }

  function refreshCapacities(): void {
    for (const refresh of paramRefreshers) refresh();
  }

  // ------------------------------------------------------------- guidance
  //
  // At the top of the control column, next to the controls it names. Dismissible
  // and gone for good within the session: it is scaffolding for the first minute,
  // and a presenter driving this in front of a room should not have to talk over
  // instructions aimed at somebody else.
  const guidanceCard = element("aside", "wtr-guidance");
  if (options.guidance !== undefined) {
    const { title, intro, steps } = options.guidance;
    guidanceCard.dataset["guidance"] = "open";

    const dismiss = element("button", "wtr-guidance-dismiss", "Dismiss");
    dismiss.type = "button";
    dismiss.dataset["action"] = "dismiss-guidance";
    dismiss.setAttribute("aria-label", "Dismiss the tour");
    dismiss.addEventListener("click", () => {
      guidanceCard.dataset["guidance"] = "dismissed";
      guidanceCard.replaceChildren();
    });

    const head = element("div", "wtr-guidance-head");
    head.append(element("h2", "wtr-guidance-title", title), dismiss);

    // An ordered list because it genuinely is one: each step only makes sense
    // after the one before it has happened.
    const list = element("ol", "wtr-guidance-steps");
    for (const step of steps) {
      const item = element("li", "wtr-guidance-step");
      item.append(
        element("strong", "wtr-guidance-action", step.action),
        element("span", "wtr-guidance-watch", step.watch),
      );
      list.append(item);
    }

    guidanceCard.append(head, element("p", "wtr-guidance-intro", intro), list);
  }

  const legendList = element("ul", "wtr-legend");

  // The validation panel mounts here, between the model and the controls, rather
  // than at the end of the document. Appended at the bottom it opened below the
  // fold, so clicking "Validation" looked like nothing had happened.
  const panelHost = element("div", "wtr-panel-host");

  // The canvas is the product, so it gets the height and the parameters go beside
  // it. Stacked underneath, every knob added came straight out of the picture —
  // which is how the first capacity control shrank the model to a strip.
  const steerHint = element(
    "p",
    "wtr-preset-note",
    "Click a box on the canvas to steer it. The one that folds first opens on its own.",
  );
  const controlColumn = element("aside", "wtr-controls");
  controlColumn.append(guidanceCard, presetRow, steerHint, paramRow, legendList);

  root.append(stats, alerts, stage, transport, changeList, controlColumn, panelHost);
  root.dataset["mode"] = "desk";

  // ------------------------------------------------------------- selection
  /** The component the driver pointed at; `null` when nothing is. */
  let selectedNode: string | null = null;
  /** The culprit already opened for, so a lasting fold opens its section once. */
  let openedFor: string | null = null;
  let lastFrame: ReturnType<typeof frameFor> | null = null;

  const sectionOf = (nodeId: string): Section | undefined =>
    sections.find((section) => section.nodeIds.includes(nodeId));

  /** Put the selected component's section in the card (Present) or back in the column. */
  const placeCard = (): void => {
    const presenting = root.dataset["mode"] === "present";
    const section = selectedNode === null ? undefined : sectionOf(selectedNode);
    for (const candidate of sections) {
      const home = presenting && candidate === section ? steerCard : paramRow;
      if (candidate.element.parentElement !== home) {
        if (home === paramRow) {
          // Back in model order, so the column does not reshuffle as boxes are clicked.
          const after = sections.slice(sections.indexOf(candidate) + 1).find((next) => next.element.parentElement === paramRow);
          paramRow.insertBefore(candidate.element, after?.element ?? null);
        } else {
          home.append(candidate.element);
        }
      }
    }
    steerCard.dataset["card"] = presenting && section !== undefined ? "open" : "empty";
    if (!presenting || section === undefined || lastFrame === null || selectedNode === null) return;

    // Next to the box, in space nothing else is drawn in: above or below it
    // first, because wires run left to right and a card to either side covers
    // the very components the room is looking at. Beside it only when neither
    // above nor below has room.
    const place = lastFrame.nodes.find((node) => node.id === selectedNode)?.place;
    const rect = canvas.getBoundingClientRect();
    if (place === undefined || rect.width === 0) return;
    const { scale, offsetX, offsetY } = computeViewport(rect.width, rect.height, lastFrame.box);
    const box = {
      left: offsetX + place.x * scale,
      top: offsetY + place.y * scale,
      right: offsetX + (place.x + place.w) * scale,
      bottom: offsetY + (place.y + place.h) * scale,
    };
    const gap = 12;
    const width = steerCard.offsetWidth || 300;
    const height = steerCard.offsetHeight || 180;
    const alignedLeft = Math.min(Math.max(8, box.right - width), rect.width - width - 8);

    let left: number;
    let top: number;
    // Above clears the "first to fold" label the renderer draws over the box.
    const above = gap + 18;
    if (box.top - above - height >= 8) {
      left = alignedLeft;
      top = box.top - above - height;
    } else if (box.bottom + gap + height <= rect.height - 8) {
      left = alignedLeft;
      top = box.bottom + gap;
    } else {
      left = box.right + gap + width <= rect.width ? box.right + gap : Math.max(8, box.left - gap - width);
      top = Math.max(8, Math.min(box.top, rect.height - height - 8));
    }
    steerCard.style.left = `${left}px`;
    steerCard.style.top = `${top}px`;
  };

  const select = (nodeId: string | null): void => {
    selectedNode = nodeId;
    for (const section of sections) section.element.open = nodeId !== null && section.nodeIds.includes(nodeId);
    placeCard();
    player?.repaint();
  };

  present.addEventListener("click", () => {
    const presenting = root.dataset["mode"] !== "present";
    root.dataset["mode"] = presenting ? "present" : "desk";
    present.textContent = presenting ? "Back to desk" : "Present";
    // Presets steer the demo's story and belong to no one box, so in Present mode
    // they ride in the bottom strip rather than vanishing with the column.
    (presenting ? transport : controlColumn).insertBefore(
      presetRow,
      presenting ? null : steerHint,
    );
    placeCard();
    player?.repaint();
  });

  const onCanvasClick = (event: MouseEvent): void => {
    const id = renderer?.nodeAt(event, lastFrame ?? frameFor({ model: sim.recorded().model, snapshot: sim.snapshot(), series: sim.series() })) ?? null;
    select(id);
  };

  // ----------------------------------------------------------------- wiring
  let renderer: Renderer | null = null;
  let player: Player | null = null;
  let panel: ValidationPanel | null = null;
  let verdict: VerdictPanel | null = null;
  let legendPainted = false;

  const rate = (value: number): string =>
    value >= 100 ? `${Math.round(value)}` : value >= 10 ? value.toFixed(1) : value.toFixed(2);

  const draw = (): void => {
    const frame = frameFor({ model: sim.recorded().model, snapshot: sim.snapshot(), series: sim.series() });
    lastFrame = frame;
    renderer?.paint(frame, {
      selectedNode,
      ...(options.labels === undefined ? {} : { kindLabels: options.labels }),
      ...(options.assumed === undefined ? {} : { assumed: options.assumed }),
    });

    // The component that started the trouble opens its own knobs, once per fold.
    // Opens only: closing what the driver opened would pull a field out from under
    // a hand that is about to type in it.
    const culprit = frame.culprit?.id ?? null;
    if (culprit !== openedFor) {
      openedFor = culprit;
      const section = culprit === null ? undefined : sectionOf(culprit);
      if (section !== undefined) {
        section.element.open = true;
        if (selectedNode === null) {
          selectedNode = culprit;
          placeCard();
        }
      }
    }
    if (root.dataset["mode"] === "present") placeCard();

    offered.value.textContent = `${rate(frame.system.offered)}/s`;
    goodput.value.textContent = `${rate(frame.system.goodput)}/s`;
    dropped.value.textContent = `${rate(frame.system.dropRate)}/s`;
    latency.value.textContent =
      frame.system.latencyP95 > 0 ? `${Math.round(frame.system.latencyP95 * 1000)} ms` : "—";
    inFlight.value.textContent = String(frame.system.inFlight);

    // Repainted every frame rather than latched: the culprit can change as the
    // model is steered, and a stale accusation is worse than none.
    if (frame.culprit === null) {
      culpritLine.dataset["culprit"] = "";
      culpritLine.textContent = "";
    } else {
      const { id, reason, carrying } = frame.culprit;
      culpritLine.dataset["culprit"] = id;
      culpritLine.textContent =
        `${id} folded first — ${reason}.` +
        (carrying.length === 0
          ? ""
          : ` ${carrying.join(", ")} ${carrying.length === 1 ? "is" : "are"} red because of it, not with it.`);
    }

    // The legend is derived from what this model uses, and does not change while
    // it runs, so it is painted once rather than rebuilt sixty times a second.
    if (!legendPainted) {
      legendPainted = true;
      for (const item of frame.legend) {
        const entry = element("li", "wtr-legend-item");
        entry.append(
          element("span", `wtr-swatch wtr-swatch-${item.swatch}`),
          element("strong", undefined, item.term),
          element("span", undefined, item.meaning),
        );
        legendList.append(entry);
      }
    }
  };

  const syncPlayPause = (): void => {
    playPause.textContent = player?.isPlaying() === true ? "Pause" : "Play";
  };

  playPause.addEventListener("click", () => {
    if (player === null) return;
    if (player.isPlaying()) player.pause();
    else player.play();
    syncPlayPause();
  });

  speed.addEventListener("change", () => {
    player?.setRate(Number(speed.value));
  });

  // A pattern that would freeze the page is refused, not run.
  const patternLimit = controls.load.max * PATTERN_LIMIT_FACTOR;

  /** The current pattern at the slider's rate, laid out from sim time `from`. */
  const layLoad = (candidate: LoadPattern, from: number, seed: string): PatternResult =>
    patternSegments(candidate, Number(loadInput.value), { from, seed, limit: patternLimit });

  const showPattern = (laid: PatternResult): void => {
    patternRow.dataset["pattern"] = pattern.kind;
    patternError.textContent = laid.ok ? "" : laid.error;
    if (laid.ok) patternSummary.textContent = pattern.kind === "steady" ? "" : summarizePattern(laid);
  };

  /**
   * Replace the offered load from now on. Returns whether it was applied.
   *
   * A refused pattern leaves the run on the load it already had, for the same
   * reason a refused capacity does: the screen must never show one load while
   * the simulation obeys another.
   */
  const applyLoad = (candidate: LoadPattern): boolean => {
    const laid = layLoad(candidate, sim.now(), sim.recorded().seed);
    if (!laid.ok) {
      patternError.textContent = laid.error;
      return false;
    }
    pattern = candidate;
    // Each drag position and each pattern change is a recorded mutation carrying
    // the segments themselves, which is what makes the session replayable.
    sim.record({ kind: "set-load", segments: laid.segments });
    markSteered();
    showPattern(laid);
    return true;
  };

  loadInput.addEventListener("input", () => {
    const value = Number(loadInput.value);
    loadValue.textContent = `${value}/s`;
    if (!applyLoad(pattern)) return;
    logChange(`load → ${value}/s`, true);
    player?.repaint();
  });

  // The chosen pattern's settings. Rebuilt when the kind changes; each field
  // applies on `change`, like every typed field here.
  const buildPatternInputs = (): void => {
    patternInputs.replaceChildren();
    if (pattern.kind === "steps") {
      patternInputs.append(
        element("p", "wtr-pattern-note", "The schedule typed in the editor, played once. The slider scales every step."),
      );
      return;
    }
    if (pattern.kind === "steady") return;
    patternInputs.append(
      ...patternFields(pattern, {
        baseMeans: "the slider",
        refuse: (message) => {
          patternError.textContent = message;
        },
        apply: (next) => {
          if (!applyLoad(next)) return false;
          (patterns as Record<PatternKind, LoadPattern>)[next.kind] = next;
          logChange(`load pattern → ${describePattern(next)}`);
          player?.repaint();
          return true;
        },
      }),
    );
  };
  buildPatternInputs();
  showPattern(layLoad(pattern, 0, sim.recorded().seed));

  patternSelect.addEventListener("change", () => {
    const kind = patternSelect.value as PatternKind;
    const next = patterns[kind];
    if (!applyLoad(next)) {
      // Back to the pattern that is actually running, so the select never lies.
      patternSelect.value = pattern.kind;
      return;
    }
    buildPatternInputs();
    logChange(`load pattern → ${describePattern(next)}`);
    player?.repaint();
  });

  /**
   * Run the design that is on screen from cold.
   *
   * Same parameters, same offered load, **same seed** — so this is the same
   * arrival realization the steered run saw, not a different roll of the dice.
   * The only difference is that the queues start empty and no retry is already
   * in flight, which is precisely the variable in question.
   *
   * Deliberately a button and not an automatic consequence of turning a knob.
   * Restarting on every change would answer "what does this design do" every
   * time and make every mitigation look like it worked — erasing the fact that a
   * system in a retry spiral often *cannot* be recovered by the change that
   * would have prevented it. Both readings are real; the tool refuses to pick
   * one for you.
   */
  const rerunOn = (arm: "proposal" | "baseline"): void => {
    const previous = sim.recorded();

    let model = authored;
    if (arm === "baseline") {
      try {
        model = baselineOf(authored, comparison.delta);
      } catch (error) {
        // The view keeps running what it was running. A surface that went blank
        // because the *other* arm could not be built would lose the working half
        // of the comparison to a problem with the half nobody asked for yet.
        armError.textContent = error instanceof Error ? error.message : String(error);
        return;
      }
    }
    armError.textContent = "";
    showing = arm;
    armToggle.dataset["showing"] = arm;
    for (const [name, button] of armButtons) {
      button.dataset["selected"] = String(name === arm);
    }

    const timeline: Timeline = {
      model: {
        ...model,
        nodes: model.nodes.map((node) => ({
          ...node,
          spec: (specs.get(node.id) ?? node.spec) as Record<string, unknown>,
        })),
        edges: withLiveCalls(model.edges),
      },
      // The pattern from sim time zero, on the same seed: a clean rerun of a
      // spiky run is spiky in the same places.
      load: (() => {
        const laid = layLoad(pattern, 0, previous.seed);
        return laid.ok ? laid.segments : [{ rate: Number(loadInput.value), duration: 3600 }];
      })(),
      seed: previous.seed,
      mutations: [],
      ...(previous.arrivalProcess === undefined ? {} : { arrivalProcess: previous.arrivalProcess }),
      ...(previous.bucketWidth === undefined ? {} : { bucketWidth: previous.bucketWidth }),
    };

    const wasPlaying = player?.isPlaying() ?? true;
    player?.destroy();
    sim = createModelSimulation(timeline);

    steeredFrom = null;
    steeredBadge.dataset["steered"] = "false";
    steeredBadge.textContent = "";
    changeLog.length = 0;
    renderChanges();
    openedFor = null;

    // The legend describes the model, and the model may have changed — a run
    // with the retries switched off should stop explaining retries.
    legendPainted = false;
    legendList.replaceChildren();

    player = createPlayer({ sim, onFrame: draw, rate: Number(speed.value) });
    if (wasPlaying) player.play();
    syncPlayPause();
  };

  const rerunClean = (): void => rerunOn(showing);

  keep.addEventListener("click", () => {
    options.onKeep?.({
      specs: new Map(specs),
      calls: new Map(callPolicies),
      sources: new Map(sourceRates),
      load: { base: Number(loadInput.value), pattern },
    });
    keep.disabled = true;
    keep.textContent = "Kept in the model";
  });
  rerun.addEventListener("click", rerunClean);

  for (const [arm, button] of armButtons) {
    button.dataset["selected"] = String(arm === "proposal");
    // Switching arms is a clean rerun by construction: the engine refuses
    // structural mutation mid-run (see `engine/timeline.ts`), and a structural
    // change spliced into a running model would be a number nobody could reproduce.
    button.addEventListener("click", () => rerunOn(arm));
  }

  validate.addEventListener("click", () => {
    if (panel !== null) {
      panel.destroy();
      panel.element.remove();
      panel = null;
      validate.textContent = "Validation";
      return;
    }
    panel = createValidationPanel();
    panelHost.append(panel.element);
    validate.textContent = "Hide validation";
  });

  /**
   * The design as it stands, for the sweep to run headless.
   *
   * Built from the authored specs rather than from `sim.recorded().model`, for
   * the same reason `Rerun clean` is: the recorded model is the one the run
   * *started* with, and every knob turned since then lives in the mutation log.
   * A sweep off the recorded snapshot would silently answer for a design nobody
   * is looking at any more.
   *
   * The base rate is the slider's, not the timeline's, because the question the
   * button answers is "how much more than this can it take".
   */
  const sweepTarget = (): SweepTarget => ({
    // Always the authored design, even while the baseline is on screen: the study
    // derives its own baseline arm, and a target that was already a baseline would
    // compare a design against itself.
    model: {
      ...authored,
      nodes: authored.nodes.map((node) => ({
        ...node,
        spec: (specs.get(node.id) ?? node.spec) as Record<string, unknown>,
      })),
      edges: withLiveCalls(authored.edges),
    },
    seed: sim.recorded().seed,
    baseRate: Number(loadInput.value),
  });

  const closeVerdict = (): void => {
    verdict?.destroy();
    verdict?.element.remove();
    verdict = null;
    breakingPoint.textContent = "Breaking point";
  };

  breakingPoint.addEventListener("click", () => {
    if (verdict !== null) {
      closeVerdict();
      return;
    }
    verdict = createVerdictPanel(sweepTarget(), comparison);
    panelHost.append(verdict.element);
    breakingPoint.textContent = "Hide breaking point";
  });

  const onResize = (): void => player?.repaint();

  return {
    element: root,
    simulation: () => sim,

    start() {
      renderer = createRenderer(canvas);
      player = createPlayer({ sim, onFrame: draw });
      globalThis.addEventListener("resize", onResize);
      canvas.addEventListener("click", onCanvasClick);
      player.play();
      syncPlayPause();
    },

    destroy() {
      globalThis.removeEventListener("resize", onResize);
      canvas.removeEventListener("click", onCanvasClick);
      panel?.destroy();
      panel = null;
      verdict?.destroy();
      verdict = null;
      player?.destroy();
      player = null;
      renderer?.destroy();
      renderer = null;
    },
  };
}
