/**
 * The settings of a spiky, random or formula load pattern, as text fields.
 *
 * Shared by the editor, where a pattern is saved with the model, and the run
 * surface, where it is changed live. One set of fields so the two screens name
 * the same settings the same way and refuse the same bad values with the same
 * words.
 *
 * Each field applies on `change`, like every typed field in the app. A value
 * that does not parse, or a pattern that `checkPattern` refuses, goes to
 * `refuse` and nothing is applied.
 */
import { checkPattern, type LoadPattern, type PatternKind, type ShapedPattern } from "../model/load-pattern.ts";

export const PATTERN_LABELS: Record<PatternKind, string> = {
  steady: "Steady",
  steps: "Steps",
  spiky: "Spiky",
  random: "Random",
  formula: "Formula",
};

export interface PatternFieldOptions {
  /** Apply a checked pattern. Returns whether it was taken. */
  apply(next: ShapedPattern): boolean;
  refuse(message: string): void;
  /** What `base` is called on this screen, for the formula's help line. */
  baseMeans: string;
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

function number(text: string, what: string): number | string {
  const value = Number(text.replace(/[×x%s]$/i, "").trim());
  return text === "" || !Number.isFinite(value) ? `"${text}" is not a number of ${what}.` : value;
}

export function patternFields(pattern: ShapedPattern, options: PatternFieldOptions): HTMLElement[] {
  // The pattern the fields stand for now. Advanced on every applied change, so a
  // second field edits the result of the first and not the pattern as it opened.
  let current: ShapedPattern = pattern;
  const nodes: HTMLElement[] = [];

  const addInput = (
    key: string,
    label: string,
    unit: string,
    value: string,
    update: (text: string) => ShapedPattern | string,
    className = "wtr-number wtr-number-small",
  ): void => {
    const input = element("input", className);
    input.type = "text";
    input.value = value;
    input.dataset["action"] = `pattern:${key}`;
    input.setAttribute("aria-label", unit === "" ? label : `${label}, ${unit}`);
    input.spellcheck = false;
    input.addEventListener("change", () => {
      const next = update(input.value.trim());
      if (typeof next === "string") {
        options.refuse(next);
        return;
      }
      const problem = checkPattern(next as LoadPattern);
      if (problem !== null) {
        options.refuse(problem);
        return;
      }
      // Focus leaving a field already applied fires `change` too; a no-op would
      // put a duplicate chip on screen and a duplicate entry in the log.
      if (JSON.stringify(next) === JSON.stringify(current)) return;
      if (options.apply(next)) current = next;
    });
    const field = element("label", "wtr-field");
    field.append(element("span", "wtr-field-label", label), input);
    if (unit !== "") field.append(element("span", "wtr-field-unit", unit));
    nodes.push(field);
  };

  if (pattern.kind === "spiky") {
    addInput("height", "Spike", "× load", String(pattern.height), (text) => {
      const height = number(text, "times the load");
      return typeof height === "string" ? height : { ...(current as typeof pattern), height };
    });
    addInput("lasting", "For", "s", String(pattern.lasting), (text) => {
      const lasting = number(text, "seconds");
      return typeof lasting === "string" ? lasting : { ...(current as typeof pattern), lasting };
    });
    addInput("every", "Every", "s", String(pattern.every), (text) => {
      const every = number(text, "seconds");
      return typeof every === "string" ? every : { ...(current as typeof pattern), every };
    });
  } else if (pattern.kind === "random") {
    addInput("spread", "Swing ±", "%", String(Math.round(pattern.spread * 100)), (text) => {
      const percent = number(text, "percent");
      return typeof percent === "string" ? percent : { ...(current as typeof pattern), spread: percent / 100 };
    });
    addInput("every", "New rate every", "s", String(pattern.every), (text) => {
      const every = number(text, "seconds");
      return typeof every === "string" ? every : { ...(current as typeof pattern), every };
    });
  } else {
    addInput("formula", "Rate =", "", pattern.text, (text) => ({ kind: "formula", text }), "wtr-number wtr-formula");
    nodes.push(
      element(
        "p",
        "wtr-pattern-note wtr-formula-help",
        `Requests a second at time t (seconds since the run started), read once a second. base is ${options.baseMeans}. ` +
          "Use + − × ÷ ^, sin, cos, abs, min, max, floor, sqrt, exp, pi, and a ? b : c, for example t > 60 ? base * 2 : base.",
      ),
    );
  }
  return nodes;
}
