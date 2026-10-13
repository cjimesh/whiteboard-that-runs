/**
 * The four things a sweep can come back with, and the sentence each one earns.
 *
 * Written against hand-built results rather than real sweeps, because what is
 * under test here is the claim made *about* a result — including the claims that
 * are refusals to answer. A readout that quietly turned every outcome into
 * "holds to ~X" would pass a test suite made only of successful sweeps.
 */
import { describe, expect, it } from "vitest";
import { formatReadout, readoutFor, studyReadoutFor } from "./readout.ts";
import { SWEEP_BUDGET, type Probe, type SweepResult } from "./sweep.ts";
import type { Verdict } from "./instability.ts";
import type { Study, StudyArm } from "./study.ts";

function verdict(holds: boolean): Verdict {
  return {
    holds,
    cause: holds ? null : "loss",
    reason: holds ? "serving 26/s of 26/s offered, with work in the system flat" : "serving 0.00/s of 30/s offered",
    signals: {
      offered: 30,
      goodput: holds ? 30 : 0,
      deficit: holds ? 0 : 1,
      growth: 0,
      growthFraction: 0,
      busiest: 1,
      measuredSeconds: SWEEP_BUDGET.measureSeconds,
    },
  };
}

function probe(rate: number, holds: boolean, seed = "seed"): Probe {
  return { rate, verdict: verdict(holds), seed };
}

function result(overrides: Partial<SweepResult> = {}): SweepResult {
  return {
    holds: 26,
    folds: 27.5,
    ceiling: 176,
    floor: 2.75,
    firstToFold: "orders-db",
    firstToFoldReason: "its queue is full and it is losing 20/s",
    seedSensitive: false,
    confirmation: probe(26, true, "seed/confirm"),
    probes: [probe(22, true), probe(44, false), probe(26, true), probe(27.5, false)],
    budget: SWEEP_BUDGET,
    baseRate: 22,
    ...overrides,
  };
}

describe("the ordinary answer", () => {
  it("states the bracket and who went first", () => {
    const readout = readoutFor(result());

    expect(readout.kind).toBe("bracket");
    expect(readout.headline).toContain("Holds to ~26.0/s");
    expect(readout.headline).toContain("Folds by 27.5/s");
    expect(readout.culprit).toContain("orders-db");
    expect(formatReadout(readout)).toContain("its queue is full");
  });

  it("carries the observation window, because every verdict is relative to it", () => {
    const readout = readoutFor(result());

    expect(readout.qualifier).toContain(`${SWEEP_BUDGET.measureSeconds}s`);
    expect(readout.qualifier).toContain("8%");
  });

  it("names the window the run actually had, not the one that was asked for", () => {
    // The cost ceiling shortens the window on fast models. A qualifier still
    // quoting 240s there would be describing a run that never happened.
    const shortened = result({ budget: { ...SWEEP_BUDGET, measureSeconds: 55 } });

    expect(readoutFor(shortened).qualifier).toContain("55s");
    expect(readoutFor(shortened).qualifier).not.toContain("240s");
  });

  it("says whether the second arrival stream agreed", () => {
    expect(readoutFor(result()).qualifier).toContain("held too");
  });
});

describe("the answers that are not a bracket", () => {
  it("refuses to name a breaking point when the design has none", () => {
    const readout = readoutFor(result({ seedSensitive: true, confirmation: probe(26, false, "seed/confirm") }));

    expect(readout.kind).toBe("no-threshold");
    expect(readout.headline).toContain("No clean breaking point");
    expect(readout.headline).toContain("chance event");
    // Still names the component, because which one goes first is not in doubt.
    expect(readout.culprit).toContain("orders-db");
  });

  it("says how far it searched when nothing folded, rather than inventing a limit", () => {
    const readout = readoutFor(result({ folds: null, holds: 176, firstToFold: null, firstToFoldReason: null }));

    expect(readout.kind).toBe("holds-beyond");
    expect(readout.headline).toContain("Holds beyond 176/s");
    expect(readout.culprit).toBeNull();
  });

  it("says the floor is already folding rather than reporting a breaking point below it", () => {
    const readout = readoutFor(result({ holds: null, folds: 2.75, confirmation: null }));

    expect(readout.kind).toBe("folds-at-floor");
    expect(readout.headline).toContain("Folds even at 2.75/s");
    expect(readout.qualifier).not.toContain("second arrival stream");
  });
});


// ------------------------------------------------------------------- studies

function arm(overrides: Partial<StudyArm> & { label: string }): StudyArm {
  return {
    side: "design",
    end: null,
    result: result(),
    error: null,
    ...overrides,
  };
}

function study(overrides: Partial<Study> = {}): Study {
  return { arms: [arm({ label: "This design" })], disputed: null, hasDelta: false, ...overrides };
}

describe("comparing a proposal against its baseline", () => {
  it("puts both numbers in one sentence, with the change between them", () => {
    const readout = studyReadoutFor(
      study({
        hasDelta: true,
        arms: [
          arm({ label: "Proposal", side: "proposal", result: result({ holds: 72, folds: 78 }) }),
          arm({ label: "Baseline", side: "baseline", result: result({ holds: 26, folds: 27.5 }) }),
        ],
      }),
    );

    expect(readout.headline).toContain("proposal holds to ~72");
    expect(readout.headline).toContain("without it, ~26");
    expect(readout.headline).toMatch(/about \d+% more/);
    expect(readout.lines.map((line) => line.label)).toEqual(["Proposal", "Baseline"]);
  });

  it("refuses to call a difference the sweep cannot resolve an improvement", () => {
    // 4% apart, on a search that reports brackets no narrower than 8%. Quoting
    // "4% better" here would be the tool inventing a result for the proposal.
    const readout = studyReadoutFor(
      study({
        hasDelta: true,
        arms: [
          arm({ label: "Proposal", side: "proposal", result: result({ holds: 26, folds: 28 }) }),
          arm({ label: "Baseline", side: "baseline", result: result({ holds: 25, folds: 27 }) }),
        ],
      }),
    );

    expect(readout.headline).toContain("too small for this sweep to call");
    expect(readout.headline).toContain("buys nothing");
  });

  it("will not compare against an arm that never folded, because that number is open-ended", () => {
    const readout = studyReadoutFor(
      study({
        hasDelta: true,
        arms: [
          arm({ label: "Proposal", side: "proposal", result: result({ holds: 176, folds: null }) }),
          arm({ label: "Baseline", side: "baseline", result: result({ holds: 26, folds: 27.5 }) }),
        ],
      }),
    );

    expect(readout.headline).toContain("cannot be compared as two numbers");
    expect(readout.lines[0]?.kind).toBe("holds-beyond");
  });
});

describe("a band across a disputed range", () => {
  const disputed = { label: "orders-db capacity", min: 40, max: 60 };

  it("states the span and what it depends on", () => {
    const readout = studyReadoutFor(
      study({
        disputed,
        arms: [
          arm({ label: "low", end: "low", result: result({ holds: 18, folds: 19.5 }) }),
          arm({ label: "high", end: "high", result: result({ holds: 33, folds: 35 }) }),
        ],
      }),
    );

    expect(readout.headline).toContain("Holds to ~18.0/s to ~33.0/s");
    expect(readout.headline).toContain("orders-db capacity really sits between 40 and 60");
  });

  it("still gives the span when neither end is a clean threshold, and says so", () => {
    // Refusing here was the first version and it was too strict: on a metastable
    // design every arm is seed-sensitive, so the band would never say anything —
    // and metastable designs are exactly the ones worth putting a band around.
    const sensitive = (holds: number, folds: number) =>
      result({ holds, folds, seedSensitive: true, confirmation: probe(holds, false, "seed/confirm") });

    const readout = studyReadoutFor(
      study({
        disputed,
        arms: [
          arm({ label: "low", end: "low", result: sensitive(18, 19.5) }),
          arm({ label: "high", end: "high", result: sensitive(33, 35) }),
        ],
      }),
    );

    expect(readout.headline).toContain("~18.0/s to ~33.0/s");
    expect(readout.headline).toContain("Neither figure is a clean threshold");
  });

  it("counts how many figures are not clean when only some are", () => {
    const readout = studyReadoutFor(
      study({
        disputed,
        arms: [
          arm({ label: "low", end: "low", result: result({ holds: 18, folds: 19.5 }) }),
          arm({
            label: "high",
            end: "high",
            result: result({ holds: 33, folds: 35, seedSensitive: true, confirmation: probe(33, false, "s/confirm") }),
          }),
        ],
      }),
    );

    expect(readout.headline).toContain("One of those figures is not a clean threshold");
  });
});

describe("both at once, and neither", () => {
  it("reports a proposal and a baseline each as a range", () => {
    const readout = studyReadoutFor(
      study({
        hasDelta: true,
        disputed: { label: "db capacity", min: 40, max: 60 },
        arms: [
          arm({ label: "P low", side: "proposal", end: "low", result: result({ holds: 49, folds: 53 }) }),
          arm({ label: "P high", side: "proposal", end: "high", result: result({ holds: 88, folds: 95 }) }),
          arm({ label: "B low", side: "baseline", end: "low", result: result({ holds: 18, folds: 19.5 }) }),
          arm({ label: "B high", side: "baseline", end: "high", result: result({ holds: 33, folds: 35 }) }),
        ],
      }),
    );

    expect(readout.headline).toContain("the proposal holds to ~49.0/s to ~88.0/s");
    expect(readout.headline).toContain("the baseline to ~18.0/s to ~33.0/s");
    expect(readout.lines).toHaveLength(4);
  });

  it("calls a study where nothing ran a failure, not a result made of failures", () => {
    const readout = studyReadoutFor(
      study({ arms: [arm({ label: "This design", result: null, error: "too fast to sweep" })] }),
    );

    expect(readout.headline).toContain("could not run");
    expect(readout.headline).toContain("too fast to sweep");
    expect(readout.qualifier).toContain("still running");
  });

  it("states each arm briefly, and explains once", () => {
    const sensitive = result({ holds: 26, folds: 27.5, seedSensitive: true, confirmation: probe(26, false, "s/confirm") });
    const compared = studyReadoutFor(
      study({
        hasDelta: true,
        arms: [
          arm({ label: "Proposal", side: "proposal", result: sensitive }),
          arm({ label: "Baseline", side: "baseline", result: result({ holds: 20, folds: 22 }) }),
        ],
      }),
    );
    const alone = studyReadoutFor(study({ arms: [arm({ label: "This design", result: sensitive })] }));

    // The long explanation is right when one arm is the whole answer, and is
    // three repetitions of the same paragraph when four are stacked up.
    expect(compared.lines[0]?.text).toBe(
      "No clean breaking point: held 26.0/s on one arrival stream, folded at the same rate on another.",
    );
    expect(alone.lines[0]?.text).toContain("Collapse here is a chance event over time");
  });

  it("says how many sweeps stood behind the answer", () => {
    const readout = studyReadoutFor(
      study({
        hasDelta: true,
        arms: [
          arm({ label: "Proposal", side: "proposal", result: result({ holds: 72, folds: 78 }) }),
          arm({ label: "Baseline", side: "baseline", result: result({ holds: 26, folds: 27.5 }) }),
        ],
      }),
    );

    expect(readout.qualifier).toContain("2 sweeps");
    expect(readout.qualifier).toContain("same arrival stream");
  });
});
