// @vitest-environment happy-dom
/**
 * The panel, driven the way the room sees it.
 *
 * There is no worker in this environment, which is convenient rather than a
 * limitation: it exercises the fallback path the shipped file needs when a
 * browser refuses a worker on a `file://` page, and it means these tests watch a
 * real sweep rather than a mocked one. The models are small enough that a real
 * sweep is a few milliseconds.
 */
import { describe, expect, it } from "vitest";
import { createVerdictPanel, type VerdictPanel } from "./verdict-panel.ts";
import type { SweepTarget } from "../verdict/sweep.ts";
import type { ComparisonSpec } from "../verdict/study.ts";

function serviceModel(mu: number): SweepTarget["model"] {
  return {
    entryId: "api",
    nodes: [
      {
        id: "api",
        kind: "service",
        spec: {
          concurrency: 1,
          service: { policy: "exponential", mean: 1 / mu },
          queue: { policy: "fifo", capacity: 200 },
          timeout: { policy: "none", after: 1 },
          retry: { policy: "none", attempts: 0, delay: 0, factor: 2, maxDelay: 1 },
        },
      },
    ],
    edges: [],
  };
}

function target(baseRate: number, mu = 50): SweepTarget {
  return { model: serviceModel(mu), seed: "panel-test", baseRate };
}

/** A service in front of a store, where the store is this month's proposal. */
function pairTarget(baseRate: number): SweepTarget {
  const model = serviceModel(200);
  return {
    model: {
      entryId: "api",
      nodes: [
        ...model.nodes,
        {
          id: "store",
          kind: "datastore",
          spec: { concurrency: 1, service: { policy: "exponential", mean: 1 / 60 }, queue: { policy: "fifo", capacity: 200 } },
        },
      ],
      edges: [{ from: "api", to: "store" }],
    },
    seed: "panel-test",
    baseRate,
  };
}

const PROPOSAL: ComparisonSpec = { delta: ["store"], disputed: null };

/** The fallback defers two frames so its message paints before the thread goes. */
async function settle(panel: VerdictPanel): Promise<void> {
  for (let i = 0; i < 4; i += 1) {
    await new Promise<void>((resolve) => globalThis.requestAnimationFrame(() => resolve()));
  }
  await Promise.resolve();
  expect(panel.element.dataset["state"]).not.toBe("running");
}

const headlineOf = (panel: VerdictPanel): string =>
  panel.element.querySelector<HTMLElement>("[data-headline]")?.textContent ?? "";

describe("while the sweep runs", () => {
  it("says what it is doing rather than showing an empty box", () => {
    const panel = createVerdictPanel(target(5));

    expect(panel.element.dataset["state"]).toBe("running");
    expect(headlineOf(panel)).not.toBe("");
    panel.destroy();
  });
});

describe("when the sweep lands", () => {
  it("shows the answer with the probes that produced it", async () => {
    const panel = createVerdictPanel(target(40));
    await settle(panel);

    expect(panel.element.dataset["state"]).toBe("done");
    // The evidence stays on screen with the claim: a bracket is only worth as
    // much as the rates that were tried to find it.
    const rows = panel.element.querySelectorAll("tbody tr");
    expect(rows.length).toBeGreaterThan(2);
    expect(headlineOf(panel)).toMatch(/Holds|Folds|No clean/);
    panel.destroy();
  });

  it("marks the one probe that did not use the design's own arrival stream", async () => {
    const panel = createVerdictPanel(target(40));
    await settle(panel);

    const rows = [...panel.element.querySelectorAll<HTMLElement>("tbody tr")];
    const marked = rows.filter((row) => row.dataset["confirmation"] === "true");

    // Exactly one, and it has to say so in the row: the same rate appearing twice
    // with opposite verdicts reads as the search contradicting itself otherwise.
    expect(marked).toHaveLength(1);
    expect(marked[0]).toBe(rows[rows.length - 1]);
    expect(marked[0]?.textContent).toContain("second arrival stream");
    expect(rows[0]?.textContent).not.toContain("second arrival stream");
    panel.destroy();
  });

  it("names the outcome so the page can style a caveat differently from an answer", async () => {
    // Nothing folds below 8 × 5/s on a queue that manages 50/s.
    const panel = createVerdictPanel(target(5));
    await settle(panel);

    expect(panel.element.dataset["result"]).toBe("holds-beyond");
    expect(headlineOf(panel)).toContain("Holds beyond");
    panel.destroy();
  });
});

describe("when the design moves on", () => {
  it("marks the answer stale instead of clearing it", async () => {
    const panel = createVerdictPanel(target(40));
    await settle(panel);
    const before = headlineOf(panel);

    panel.markStale();

    const stale = panel.element.querySelector<HTMLElement>("[data-stale]");
    expect(stale?.dataset["stale"]).toBe("true");
    expect(stale?.textContent).toContain("design has changed");
    // The old answer is still evidence; wiping it mid-argument would be its own lie.
    expect(headlineOf(panel)).toBe(before);
    panel.destroy();
  });

  it("says nothing about staleness until something has changed", async () => {
    const panel = createVerdictPanel(target(40));
    await settle(panel);

    expect(panel.element.querySelector<HTMLElement>("[data-stale]")?.dataset["stale"]).toBe("false");
    panel.destroy();
  });
});

describe("when the sweep cannot run", () => {
  it("reports the failure and says the model is untouched", async () => {
    // Too fast to sweep inside the declared cost ceiling.
    const panel = createVerdictPanel(target(50_000));
    await settle(panel);

    expect(panel.element.dataset["state"]).toBe("error");
    expect(headlineOf(panel)).toContain("could not run");
    expect(panel.element.textContent).toContain("still running");
    panel.destroy();
  });

  it("stops touching the page once destroyed", async () => {
    const panel = createVerdictPanel(target(40));
    panel.destroy();

    for (let i = 0; i < 4; i += 1) {
      await new Promise<void>((resolve) => globalThis.requestAnimationFrame(() => resolve()));
    }

    expect(panel.element.dataset["state"]).toBe("running");
    expect(panel.element.querySelectorAll("tbody tr").length).toBe(0);
  });
});


describe("when there is something to compare", { timeout: 30_000 }, () => {
  // Two sweeps, each a full bisection, and the default 5s budget is a coin flip
  // for it once the rest of the suite is competing for cores: it passed alone in
  // 8s and timed out in the full run. The work is real, so the allowance is what
  // moves rather than the test.
  it("gives each arm its own claim and its own probes", { timeout: 30_000 }, async () => {
    const panel = createVerdictPanel(pairTarget(30), PROPOSAL);
    await settle(panel);

    const sections = [...panel.element.querySelectorAll<HTMLElement>("[data-arm]")];
    expect(sections.map((section) => section.dataset["arm"])).toEqual(["Proposal", "Baseline"]);
    // The evidence for "the proposal holds to X" is the proposal's own probes. One
    // merged table would leave the reader to sort them out.
    for (const section of sections) {
      expect(section.querySelectorAll("tbody tr").length).toBeGreaterThan(1);
    }
    panel.destroy();
  });

  it("says up front that the arms share an arrival stream", async () => {
    const panel = createVerdictPanel(pairTarget(30), PROPOSAL);
    await settle(panel);

    expect(panel.element.querySelector(".wtr-verdict-title")?.textContent).toContain("each of these");
    expect(panel.element.textContent).toContain("same arrival stream");
    panel.destroy();
  });

  it("folds each arm's probes away, so the claims being compared sit together", async () => {
    const panel = createVerdictPanel(pairTarget(30), PROPOSAL);
    await settle(panel);

    const folded = panel.element.querySelectorAll("[data-arm] details");
    expect(folded).toHaveLength(2);
    // Folded, not dropped: a bracket without its probes is an assertion.
    for (const details of folded) expect(details.querySelectorAll("tbody tr").length).toBeGreaterThan(1);
    panel.destroy();
  });

  it("leaves the probes open when they are the whole panel", async () => {
    const panel = createVerdictPanel(target(40));
    await settle(panel);

    expect(panel.element.querySelector("details")).toBeNull();
    panel.destroy();
  });

  it("labels nothing when there is only one design in question", async () => {
    const panel = createVerdictPanel(target(40));
    await settle(panel);

    // Calling a single arm "This design" on screen says nothing the heading has
    // not already said.
    expect(panel.element.querySelector(".wtr-verdict-arm-title")).toBeNull();
    panel.destroy();
  });
});
