/**
 * The sweep in a sentence somebody can repeat in a meeting.
 *
 * The origin's R10 asks for "holds to ~X; first to fold: N", and the temptation
 * in writing that is to always produce it — to pick a number even when the
 * search did not find one. Four things can come back from a sweep and only one
 * of them is a breaking point, so this returns four differently-shaped
 * statements rather than one template with holes in it:
 *
 * - a **bracket**, when the search separated a rate that holds from one that folds
 * - **holds beyond**, when nothing folded up to the ceiling searched
 * - **folds at the floor**, when even the lowest rate tried was already failing
 * - **no clean threshold**, when the holding rate folded on a second arrival stream
 *
 * The last of those is the one worth having. A design whose collapse is a rare
 * burst tipping a feedback loop does not have a breaking point; it has a
 * probability per unit time. Reporting "holds to 26/s" for it would be the most
 * quotable sentence this tool ever produced and also a false one.
 *
 * Every statement carries the observation window, because every verdict is
 * relative to it. "Holds to 26/s" is shorthand for "held 26/s for four simulated
 * minutes", and the shorthand is exactly what a room would carry away as a
 * property of the design.
 */
import type { SweepResult } from "./sweep.ts";
import type { Study, StudyArm } from "./study.ts";

export type ReadoutKind = "bracket" | "holds-beyond" | "folds-at-floor" | "no-threshold";

export interface Readout {
  kind: ReadoutKind;
  /** The answer, one sentence. */
  headline: string;
  /** Which component went first and why. `null` when nothing folded. */
  culprit: string | null;
  /** What the answer is relative to: the window, the probe count, the resolution. */
  qualifier: string;
}

/** Rates are quoted at the precision the sweep can actually distinguish. */
function rate(value: number): string {
  return value >= 100 ? String(Math.round(value)) : value >= 10 ? value.toFixed(1) : value.toFixed(2);
}

function culpritOf(result: SweepResult): string | null {
  if (result.firstToFold === null) return null;
  const reason = result.firstToFoldReason === null ? "" : ` — ${result.firstToFoldReason}`;
  return `First to fold: ${result.firstToFold}${reason}.`;
}

export function readoutFor(result: SweepResult): Readout {
  const { budget } = result;
  const confirmed =
    result.confirmation === null
      ? ""
      : ` One further probe re-ran ${rate(result.confirmation.rate)}/s on a second arrival stream, ` +
        `which ${result.confirmation.verdict.holds ? "held too" : "did not hold"}.`;

  const qualifier =
    `${result.probes.length} probes, each holding one steady rate for ${budget.measureSeconds}s ` +
    `after ${budget.warmUpSeconds}s of warm-up, all on the same arrival stream so the rate is the ` +
    `only thing that changed.${confirmed} Rates closer together than ` +
    `${Math.round(budget.resolution * 100)}% are not distinguishable at this budget.`;

  if (result.seedSensitive) {
    return {
      kind: "no-threshold",
      headline:
        `No clean breaking point. This design held ${rate(result.holds ?? 0)}/s on one arrival ` +
        "stream and folded at the same rate on another, so what it survives is a matter of which " +
        "requests happen to turn up. Collapse here is a chance event over time, not a rate.",
      culprit: culpritOf(result),
      qualifier,
    };
  }

  if (result.folds === null) {
    return {
      kind: "holds-beyond",
      headline:
        `Holds beyond ${rate(result.ceiling)}/s — ${Math.round(budget.ceilingMultiple)}× the load it is ` +
        "running at, and the highest rate this sweep searched. Nothing folded.",
      culprit: null,
      qualifier,
    };
  }

  if (result.holds === null) {
    return {
      kind: "folds-at-floor",
      headline:
        `Folds even at ${rate(result.floor)}/s, the lowest rate searched. This design is not holding ` +
        "the load it is being given.",
      culprit: culpritOf(result),
      qualifier,
    };
  }

  return {
    kind: "bracket",
    headline: `Holds to ~${rate(result.holds)}/s. Folds by ${rate(result.folds)}/s.`,
    culprit: culpritOf(result),
    qualifier,
  };
}

/** One-line text form, for capture scripts and failing tests. */
export function formatReadout(readout: Readout): string {
  return [readout.headline, readout.culprit].filter((part) => part !== null).join(" ");
}


// ------------------------------------------------------------------- studies

export interface ArmLine {
  label: string;
  kind: ReadoutKind | "error";
  /** The arm's own answer, or why it has none. */
  text: string;
  culprit: string | null;
}

export interface StudyReadout {
  /** The comparison in one sentence, which is the thing that gets repeated. */
  headline: string;
  lines: ArmLine[];
  qualifier: string;
}

/**
 * The rate a bracket is quoted by, and whether it is a clean one.
 *
 * The highest rate that held, because that is the claim a design can carry —
 * "folds by 27.5" is the bound on the other side and belongs in the arm's own
 * line rather than in a comparison.
 *
 * `null` only when there is genuinely no number: an arm that failed, one that
 * folded at the floor of its search, or one that held past the ceiling. Both of
 * those last two are open-ended, and quoting the edge of the search as if it were
 * the answer would understate or overstate by an unknown amount.
 *
 * A seed-sensitive result **is** quoted, with `clean: false`. Refusing to compare
 * those was the first version and it was too strict: metastable designs are
 * exactly the ones worth comparing, and on a design like the demo every arm is
 * seed-sensitive, so the band would have said nothing at all. The comparison
 * carries the caveat instead of withholding the number.
 */
function quotable(arm: StudyArm): { value: number; clean: boolean } | null {
  const result = arm.result;
  if (result === null || result.holds === null || result.folds === null) return null;
  return { value: result.holds, clean: !result.seedSensitive };
}

/** The caveat a comparison built from seed-sensitive arms has to carry. */
const NO_CLEAN_THRESHOLD =
  " Neither figure is a clean threshold — at those rates this design survives or collapses depending on " +
  "which requests turn up, so read them as where the trouble starts, not as a limit.";

function caveatFor(ends: ReadonlyArray<{ clean: boolean }>): string {
  const dirty = ends.filter((end) => !end.clean).length;
  if (dirty === 0) return "";
  if (dirty === ends.length) return NO_CLEAN_THRESHOLD;
  return (
    ` ${dirty === 1 ? "One of those figures is not a clean threshold" : `${dirty} of those figures are not clean thresholds`}: ` +
    "at that rate the design survives or collapses depending on which requests turn up."
  );
}

/** A parameter value as an author typed it: 40, not 40.0. */
function plain(value: number): string {
  return String(Number(value.toFixed(2)));
}

/**
 * An arm's answer in one line.
 *
 * The single-sweep headlines explain themselves at length, which is right when
 * one of them is the whole answer and wrong when four are stacked up: the
 * explanation is identical in each, the comparison's own headline already carries
 * it, and three repetitions of it push the arms being compared off the screen.
 * So a comparison states each arm and lets the headline do the explaining.
 */
function shortLine(result: SweepResult): string {
  if (result.seedSensitive) {
    return (
      `No clean breaking point: held ${rate(result.holds ?? 0)}/s on one arrival stream, ` +
      "folded at the same rate on another."
    );
  }
  if (result.folds === null) return `Holds beyond ${rate(result.ceiling)}/s — nothing folded.`;
  if (result.holds === null) return `Folds even at ${rate(result.floor)}/s, the lowest rate searched.`;
  return `Holds to ~${rate(result.holds)}/s, folds by ${rate(result.folds)}/s.`;
}

function armLine(arm: StudyArm, compact: boolean): ArmLine {
  if (arm.result === null) {
    return { label: arm.label, kind: "error", text: arm.error ?? "this arm could not be run", culprit: null };
  }
  const readout = readoutFor(arm.result);
  return {
    label: arm.label,
    kind: readout.kind,
    text: compact ? shortLine(arm.result) : readout.headline,
    culprit: readout.culprit,
  };
}

/** The two ends of a disputed range, as one span. */
function span(arms: readonly StudyArm[]): { text: string; ends: Array<{ clean: boolean }> } | null {
  const low = quotable(arms.find((arm) => arm.end === "low") ?? (arms[0] as StudyArm));
  const high = quotable(arms.find((arm) => arm.end === "high") ?? (arms[0] as StudyArm));
  if (low === null || high === null) return null;

  const [least, most] = low.value <= high.value ? [low.value, high.value] : [high.value, low.value];
  return {
    text: least === most ? `~${rate(least)}/s` : `~${rate(least)}/s to ~${rate(most)}/s`,
    ends: [low, high],
  };
}

/**
 * What the comparison amounts to.
 *
 * Four shapes, and the rule that decides between them is the same one the single
 * readout follows: say the thing that is true, and when the sweeps did not
 * produce something a sentence can be built from, say that instead of building
 * the sentence anyway. An arm that folded at its floor, held past its ceiling, or
 * turned out to have no clean threshold is not a number, and averaging it into a
 * comparison would produce the most quotable line in the tool out of the least
 * reliable input it has.
 */
export function studyReadoutFor(study: Study): StudyReadout {
  const lines = study.arms.map((arm) => armLine(arm, study.arms.length > 1));
  const budget = study.arms.find((arm) => arm.result !== null)?.result?.budget;

  const qualifier =
    (budget === undefined
      ? ""
      : `Each rate held steady for ${budget.measureSeconds}s, ` +
        `rates closer together than ${Math.round(budget.resolution * 100)}% not distinguishable. `) +
    `${study.arms.length} sweep${study.arms.length === 1 ? "" : "s"}, all on the same arrival stream — ` +
    "so what differs between them is what was changed, not which requests turned up.";

  // Nothing ran at all. Reported as a failure rather than as a result made of
  // failures — there is no answer here to qualify.
  if (lines.length > 0 && lines.every((line) => line.kind === "error")) {
    return {
      headline: `The sweep could not run: ${lines[0]?.text ?? "no arm produced a result"}`,
      lines,
      qualifier: "The model on screen is unaffected — it is still running.",
    };
  }

  const proposal = study.arms.filter((arm) => arm.side === "proposal");
  const baseline = study.arms.filter((arm) => arm.side === "baseline");

  // Nothing to compare: the single-sweep sentence, unchanged.
  if (!study.hasDelta && study.disputed === null) {
    return { headline: lines[0]?.text ?? "Nothing was swept.", lines, qualifier };
  }

  if (study.hasDelta && study.disputed === null) {
    const gained = quotable(proposal[0] as StudyArm);
    const had = quotable(baseline[0] as StudyArm);
    if (gained === null || had === null) {
      return {
        headline: "The proposal and the baseline cannot be compared as two numbers — see each one below.",
        lines,
        qualifier,
      };
    }
    const change = had.value === 0 ? null : (gained.value - had.value) / had.value;
    // Below the sweep's own resolution, a difference is not a difference. Reporting
    // "4% better" from a search that cannot distinguish rates 8% apart would be
    // the tool inventing a result for the proposal.
    const verdict =
      change === null
        ? ""
        : Math.abs(change) <= (proposal[0]?.result?.budget.resolution ?? 0.08)
          ? " — a difference too small for this sweep to call, so on this evidence the proposal buys nothing"
          : ` — ${change > 0 ? `about ${Math.round(change * 100)}% more` : `about ${Math.round(-change * 100)}% less`} than the baseline`;
    return {
      headline:
        `The proposal holds to ~${rate(gained.value)}/s; without it, ~${rate(had.value)}/s${verdict}.` +
        caveatFor([gained, had]),
      lines,
      qualifier,
    };
  }

  if (!study.hasDelta && study.disputed !== null) {
    const range = span(study.arms);
    const disputed = study.disputed;
    if (range === null) {
      return {
        headline:
          `The two ends of the disputed ${disputed.label} do not both give a breaking point — see each below.`,
        lines,
        qualifier,
      };
    }
    return {
      headline:
        `Holds to ${range.text}, depending where ${disputed.label} really sits between ` +
        `${plain(disputed.min)} and ${plain(disputed.max)}.` + caveatFor(range.ends),
      lines,
      qualifier,
    };
  }

  const proposalRange = span(proposal);
  const baselineRange = span(baseline);
  const disputed = study.disputed;
  if (proposalRange === null || baselineRange === null || disputed === null) {
    return {
      headline: "Not every arm produced a breaking point, so there is no single comparison — see each below.",
      lines,
      qualifier,
    };
  }
  return {
    headline:
      `Across the disputed ${disputed.label} (${plain(disputed.min)} to ${plain(disputed.max)}), the proposal ` +
      `holds to ${proposalRange.text} and the baseline to ${baselineRange.text}.` +
      caveatFor([...proposalRange.ends, ...baselineRange.ends]),
    lines,
    qualifier,
  };
}
