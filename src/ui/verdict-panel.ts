/**
 * The breaking-point panel: the load a design holds to, and what a proposal or a
 * disputed number does to it.
 *
 * Three states, all of them explicit. **Computing** — probes appear one at a time,
 * because a sweep takes a second or two and a panel that shows nothing until it is
 * finished is indistinguishable from one that has hung. **Result** — the readout,
 * the probes that produced it, and the budget it is relative to. **Failure** —
 * said plainly, with the live view untouched behind it. A sweep that dies must not
 * take the running model down with it; the model is the product, the sweep is an
 * instrument pointed at it.
 *
 * One code path for one arm or four. A design with nothing marked as a proposal
 * and nothing disputed is a study with a single arm, so there is no separate
 * simple mode to keep in step with the comparing one.
 *
 * The probe log stays on screen with the answer rather than collapsing into it.
 * "Holds to ~26/s" is a claim, and the rates that were tried, what each one did,
 * and in whose numbers is the evidence for it — which is the difference between
 * this and a dashboard that asserts a number.
 *
 * Unlike the validation panel, no worker means this just runs inline. That panel
 * asks first because its run is half a minute of frozen page; a study is a few
 * seconds, and making someone click twice for that would be ceremony.
 */
import { studyReadoutFor, type ArmLine, type StudyReadout } from "../verdict/readout.ts";
import { SWEEP_BUDGET, type Probe, type SweepTarget } from "../verdict/sweep.ts";
import { DETECTOR } from "../verdict/instability.ts";
import { runStudy, NO_COMPARISON, type ComparisonSpec, type Study } from "../verdict/study.ts";
import { createComputeClient, type ComputeClient } from "../worker/client.ts";
import type { ComputeResponse } from "../worker/protocol.ts";

export interface VerdictPanel {
  element: HTMLElement;
  /**
   * Say that the design has moved on since this answer was worked out.
   *
   * A bracket is about the design as it stood when the button was pressed. Turn a
   * timeout knob and it is about a system that is no longer on the screen — and
   * a stale number nobody has flagged is exactly the kind of thing a room quotes
   * for the next twenty minutes. Marked rather than cleared: the old answer is
   * still evidence, and wiping it mid-argument would be its own kind of lie.
   */
  markStale(): void;
  destroy(): void;
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

function rate(value: number): string {
  return value >= 100 ? String(Math.round(value)) : value >= 10 ? value.toFixed(1) : value.toFixed(2);
}

/**
 * The share of the probe's requests that never completed, shown on every row.
 *
 * "Folded" is a threshold (`DETECTOR`), and a reader whose bar is stricter or
 * looser than ours should be able to read their own answer off the table rather
 * than take the verdict word on trust. Not a setting: the threshold is the
 * detector's measured noise floor, and moving it would make the bracket mean
 * whatever number the room typed in.
 */
function lost(deficit: number): string {
  const percent = deficit * 100;
  if (percent === 0) return "0%";
  return percent < 1 ? `${percent.toFixed(1)}%` : `${Math.round(percent)}%`;
}

/**
 * One probe as a row — and the confirmation probe said to *be* one.
 *
 * Without the label the table reads as the search contradicting itself: the same
 * rate appearing twice, held then folded, with nothing on screen to say the
 * second run used a different arrival stream. That is the one row the headline is
 * actually about, so leaving it looking like an ordinary probe would make the
 * evidence argue against the claim it supports.
 */
function probeRow(probe: Probe, confirmation: boolean): HTMLElement {
  const row = element("tr", probe.verdict.holds ? "wtr-row-ok" : "wtr-row-fail");
  row.dataset["probe"] = rate(probe.rate);
  if (confirmation) row.dataset["confirmation"] = "true";

  const reason = confirmation ? `on a second arrival stream — ${probe.verdict.reason}` : probe.verdict.reason;
  const cells = [`${rate(probe.rate)}/s`, probe.verdict.holds ? "held" : "folded", lost(probe.verdict.signals.deficit), reason];
  for (const [index, text] of cells.entries()) {
    row.append(element("td", index === 0 ? "wtr-cell-label" : undefined, text));
  }
  return row;
}

interface ArmSection {
  root: HTMLElement;
  line: HTMLElement;
  culprit: HTMLElement;
  body: HTMLElement;
}

export function createVerdictPanel(
  target: SweepTarget,
  comparison: ComparisonSpec = NO_COMPARISON,
): VerdictPanel {
  const comparing = comparison.delta.length > 0 || comparison.disputed !== null;

  const root = element("section", "wtr-verdict");
  root.dataset["panel"] = "verdict";
  root.dataset["state"] = "running";

  const heading = element(
    "h2",
    "wtr-verdict-title",
    comparing ? "How much load does each of these hold?" : "How much load does this design hold?",
  );
  const blurb = element(
    "p",
    "wtr-verdict-blurb",
    "The model is run headless at one steady rate after another until the rate it stops holding is " +
      "bracketed. Nothing on screen is touched, and the search is not the load you drew — each probe " +
      "holds one rate flat, which is what a claim like 'holds to 26/s' has to mean to be worth saying. " +
      `A rate folds when more than ${DETECTOR.deficit * 100}% of its requests are lost, or work piles up by more ` +
      `than ${DETECTOR.growth * 100}% of the rate every second, over ${SWEEP_BUDGET.measureSeconds} s. ` +
      "The Lost column shows the share at every rate tried." +
      (comparing ? " Every arm runs on the same arrival stream, so what differs is what was changed." : ""),
  );

  const headline = element("p", "wtr-verdict-headline", "Searching…");
  headline.dataset["headline"] = "";

  const stale = element("p", "wtr-verdict-stale");
  stale.dataset["stale"] = "false";

  const arms = element("div", "wtr-verdict-arms");
  const qualifier = element("p", "wtr-verdict-qualifier");

  root.append(heading, blurb, headline, stale, arms, qualifier);

  const sections = new Map<string, ArmSection>();

  /**
   * An arm's block, created when its first probe arrives.
   *
   * Built on demand rather than up front from the plan, so the panel cannot show
   * an arm the study did not actually run — and so the order on screen is the
   * order the work happened in.
   */
  const sectionFor = (label: string): ArmSection => {
    const existing = sections.get(label);
    if (existing !== undefined) return existing;

    const section = element("section", "wtr-verdict-arm");
    section.dataset["arm"] = label;

    // A single-arm study is just "this design", and labelling it says nothing.
    if (comparing) section.append(element("h3", "wtr-verdict-arm-title", label));

    const line = element("p", "wtr-verdict-arm-line");
    const culprit = element("p", "wtr-verdict-culprit");
    culprit.dataset["culprit"] = "";

    const table = element("table", "wtr-verdict-table");
    const head = element("thead");
    const headRow = element("tr");
    for (const heading of ["Rate", "Verdict", "Lost", "What happened"]) headRow.append(element("th", undefined, heading));
    head.append(headRow);
    const body = element("tbody");
    table.append(head, body);

    section.append(line, culprit);

    // With one arm the probe log *is* the panel and stays open. With four, the
    // four claims are the thing being compared and each table is a page of
    // evidence between them — so the evidence folds away and the claims sit
    // together. Folded, not dropped: a bracket without its probes is an assertion.
    if (comparing) {
      const details = element("details", "wtr-verdict-probes");
      const summary = element("summary", undefined, "The probes behind this");
      details.append(summary, table);
      section.append(details);
    } else {
      section.append(table);
    }

    arms.append(section);

    const created: ArmSection = { root: section, line, culprit, body };
    sections.set(label, created);
    return created;
  };

  let client: ComputeClient | null = null;
  let destroyed = false;
  let probesSeen = 0;

  /**
   * The confirmation probe is the one that did not run on the design's own
   * arrival stream, which is a property of the probe rather than of where it
   * landed in the sequence. Counting messages instead would mislabel a search
   * that used its last probe, and would go wrong silently.
   */
  const addProbe = (arm: string, probe: Probe): void => {
    if (destroyed) return;
    probesSeen += 1;
    sectionFor(arm).body.append(probeRow(probe, probe.seed !== target.seed));
    headline.textContent = comparing
      ? `Searching… ${sections.size} of ${comparison.disputed === null || comparison.delta.length === 0 ? 2 : 4}, ${probesSeen} probes so far`
      : `Searching… ${probesSeen} probes so far`;
  };

  const showLine = (armLine: ArmLine): void => {
    const section = sectionFor(armLine.label);
    section.root.dataset["result"] = armLine.kind;
    // With one arm its line *is* the headline, and printing it under itself read
    // as the panel stuttering. The line is for telling arms apart.
    section.line.textContent = comparing ? armLine.text : "";
    section.culprit.textContent = armLine.culprit ?? "";
  };

  const show = (readout: StudyReadout): void => {
    if (destroyed) return;
    const allFailed = readout.lines.length > 0 && readout.lines.every((line) => line.kind === "error");
    root.dataset["state"] = allFailed ? "error" : "done";
    // The panel's own result code is the weakest arm's: a comparison where one
    // side could not be built is not a clean answer, whatever the other side did.
    const kinds = readout.lines.map((line) => line.kind);
    root.dataset["result"] = kinds.includes("error")
      ? "error"
      : (kinds.find((kind) => kind !== "bracket") ?? "bracket");
    headline.textContent = readout.headline;
    headline.dataset["headline"] = root.dataset["result"] ?? "";
    for (const line of readout.lines) showLine(line);
    qualifier.textContent = readout.qualifier;
  };

  const finish = (study: Study): void => {
    if (destroyed) return;
    show(studyReadoutFor(study));
  };

  const fail = (message: string): void => {
    if (destroyed) return;
    root.dataset["state"] = "error";
    root.dataset["result"] = "error";
    headline.textContent = `The sweep could not run: ${message}`;
    headline.dataset["headline"] = "error";
    qualifier.textContent = "The model on screen is unaffected — it is still running.";
  };

  const availability = createComputeClient({
    onMessage(response: ComputeResponse) {
      switch (response.kind) {
        case "probe":
          addProbe(response.arm, response.probe);
          break;
        case "studied":
          finish(response.study);
          break;
        case "error":
          fail(response.message);
          break;
        default:
          break;
      }
    },
  });

  if (availability.client === null) {
    headline.textContent =
      "No background thread available here — running on this one. The page will not respond for a " +
      "second or two.";
    // Deferred two frames so that message actually paints before the thread is
    // taken away; without it the user sees nothing until the work is over.
    globalThis.requestAnimationFrame(() => {
      globalThis.requestAnimationFrame(() => {
        if (destroyed) return;
        try {
          finish(runStudy(target, comparison, { onProbe: (arm, probe) => addProbe(arm, probe) }));
        } catch (error) {
          fail(error instanceof Error ? error.message : String(error));
        }
      });
    });
  } else {
    client = availability.client;
    client.send({ kind: "study", target, comparison });
  }

  return {
    element: root,

    markStale() {
      if (destroyed || stale.dataset["stale"] === "true") return;
      stale.dataset["stale"] = "true";
      stale.textContent =
        "The design has changed since this ran — these rates describe the earlier one. " +
        "Run the breaking point again to ask about the model as it stands now.";
    },

    destroy() {
      destroyed = true;
      client?.destroy();
      client = null;
    },
  };
}
