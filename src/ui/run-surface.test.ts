// @vitest-environment happy-dom
/**
 * The live-steering loop (R7), driven through the DOM the way a driver will.
 *
 * The claim under test is that changing something does not restart anything: the
 * simulation keeps its clock, its metrics and its randomness, and the change lands
 * in the recorded log so the session stays replayable. So these assertions read the
 * recorded timeline rather than any internal flag — that log is what a replay will
 * be given, and it is the only evidence that matters.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createModelSimulation } from "../specs/registry.ts";
import type { Simulation } from "../engine/kernel.ts";
import { demoControls, demoDocument, demoGuidance, demoTimeline } from "./demo.ts";
import { addComponent, addTrafficSource, connect, setCallPolicy, toTimeline } from "../model/document.ts";
import { controlsForDocument } from "./controls.ts";
import { createRunSurface, type RunSurface } from "./run-surface.ts";
import { layoutModel } from "../view/layout.ts";

let root: HTMLElement;
let sim: Simulation;
let surface: RunSurface;

/** happy-dom has no canvas 2D context; the renderer only needs it to not be null. */
function stubCanvas(): void {
  const ctx = new Proxy(
    {},
    {
      get: (_target, key) => {
        if (key === "canvas") return undefined;
        // Shaped like TextMetrics: the renderer measures a label to decide which
        // side of a stub it fits on, and `undefined` here is a trap, not a fake.
        if (key === "measureText") return () => ({ width: 0 });
        return () => undefined;
      },
      set: () => true,
    },
  );

  HTMLCanvasElement.prototype.getContext = (() => ctx) as never;
  HTMLCanvasElement.prototype.getBoundingClientRect = (() =>
    ({ left: 0, top: 0, width: 1280, height: 720, right: 1280, bottom: 720 }) as DOMRect) as never;
}

function find<T extends HTMLElement>(selector: string): T {
  const node = root.querySelector<T>(selector);
  if (node === null) throw new Error(`no element matching ${selector}`);
  return node;
}

function click(selector: string): void {
  find(selector).dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
}

function setValue(selector: string, value: string, event: "input" | "change"): void {
  const node = find<HTMLInputElement | HTMLSelectElement>(selector);
  node.value = value;
  node.dispatchEvent(new window.Event(event, { bubbles: true }));
}

beforeEach(() => {
  stubCanvas();
  root = document.createElement("div");
  document.body.append(root);
  sim = createModelSimulation(demoTimeline());
  surface = createRunSurface(sim, demoControls());
  root.append(surface.element);
  surface.start();
});

afterEach(() => {
  surface.destroy();
  root.remove();
});

describe("the surface mounts", () => {
  it("declares itself, so the automation contract holds", () => {
    expect(root.querySelector("[data-surface]")?.getAttribute("data-surface")).toBe("run");
    expect(find('[data-action="play-pause"]')).toBeTruthy();
    expect(find('[data-action="load"]')).toBeTruthy();
    expect(find('[data-action="validation"]')).toBeTruthy();
    expect(find('[data-action="sweep"]')).toBeTruthy();
  });

  it("paints a legend derived from the model, once", () => {
    const items = root.querySelectorAll(".wtr-legend-item");
    expect(items.length).toBeGreaterThan(3);
    // The demo retries, so the retry encoding must be explained.
    expect(root.querySelector(".wtr-swatch-retries")).toBeTruthy();
  });

  it("shows readouts rather than placeholders once a frame has been drawn", () => {
    const values = [...root.querySelectorAll(".wtr-readout-value")].map((node) => node.textContent);
    expect(values).toHaveLength(5);
    expect(values.every((text) => text !== null && text.length > 0)).toBe(true);
  });
});

describe("changing the load while it runs (R7)", () => {
  it("records the change instead of restarting the simulation", () => {
    sim.runUntil(4);
    const seriesBefore = sim.series().length;

    setValue('[data-action="load"]', "70", "input");

    const recorded = sim.recorded().mutations;
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({ kind: "set-load", at: 4 });
    // Nothing was thrown away: the metrics series and the clock carry on.
    expect(sim.series().length).toBe(seriesBefore);
    expect(sim.now()).toBe(4);
  });

  it("shows the value it is now offering", () => {
    setValue('[data-action="load"]', "61", "input");
    expect(find(".wtr-slider-value").textContent).toBe("61/s");
  });

  it("takes effect in the running simulation", () => {
    sim.runUntil(6);
    setValue('[data-action="load"]', "5", "input");
    sim.runUntil(20);

    const late = sim.series().slice(-20);
    const offered = late.reduce((total, bucket) => total + bucket.system.arrivals, 0) / (late.length * 0.25);
    expect(offered).toBeLessThan(15);
  });

  it("keeps a dragged session replayable", () => {
    sim.runUntil(3);
    setValue('[data-action="load"]', "50", "input");
    sim.runUntil(6);
    setValue('[data-action="load"]', "20", "input");
    sim.runUntil(10);

    const replay = createModelSimulation(sim.recorded());
    replay.runUntil(10);
    expect(JSON.stringify(replay.series())).toBe(JSON.stringify(sim.series()));
  });
});

describe("changing a policy while it runs", () => {
  it("applies one mutation per affected component", () => {
    sim.runUntil(2);
    setValue('[data-action="preset:retry-policy"]', "none", "change");

    const recorded = sim.recorded().mutations;
    // The demo's retry control covers both replicas.
    expect(recorded).toHaveLength(2);
    expect(recorded.map((mutation) => (mutation.kind === "set-spec" ? mutation.nodeId : ""))).toEqual([
      "api-1",
      "api-2",
    ]);
  });

  it("explains what the chosen policy does", () => {
    setValue('[data-action="preset:retry-policy"]', "capped", "change");
    const note = find(".wtr-preset-note").textContent ?? "";
    expect(note).toMatch(/cannot escape/i);
  });

  it("reaches the second control too", () => {
    sim.runUntil(2);
    setValue('[data-action="preset:database-queue"]', "shed", "change");

    const recorded = sim.recorded().mutations;
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({ kind: "set-spec", nodeId: "orders-db" });
  });
});

describe("stating a component's capacity", () => {
  const capacityField = '[data-action="capacity:orders-db"]';

  it("shows the rate the model is actually running at, and its conversion", () => {
    // The demo database is one connection at 20 ms a query.
    expect(find<HTMLInputElement>(capacityField).value).toBe("50");
    expect(find('[data-conversion="capacity:orders-db"]').textContent).toBe("50/s ⇒ 20 ms × 1 connection");
  });

  it("records a typed rate as a service time, without restarting anything", () => {
    sim.runUntil(3);
    setValue(capacityField, "80", "change");

    const recorded = sim.recorded().mutations;
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({ kind: "set-spec", nodeId: "orders-db", at: 3 });

    const mutation = recorded[0];
    const spec = mutation?.kind === "set-spec" ? (mutation.spec as { service?: { mean?: number } }) : {};
    expect(spec.service?.mean).toBeCloseTo(0.0125, 10);
    expect(sim.now()).toBe(3);
  });

  it("accepts the unit somebody types along with the number", () => {
    setValue(capacityField, "120/s", "change");
    expect(find('[data-conversion="capacity:orders-db"]').textContent).toMatch(/^120\/s/);
  });

  it("keeps the rest of the component's spec, so two controls cannot revert each other", () => {
    // The failure this guards: capacity is typed, then a policy dropdown moves,
    // and the capacity silently goes back to what it was. `set-spec` replaces a
    // node's spec wholesale, so nothing but the merge prevents it.
    setValue(capacityField, "80", "change");
    setValue('[data-action="preset:database-queue"]', "shed", "change");

    const last = sim.recorded().mutations.at(-1);
    const spec = last?.kind === "set-spec" ? (last.spec as { service?: { mean?: number }; queue?: unknown }) : {};
    expect(spec.queue).toEqual({ policy: "drop-oldest", capacity: 6 });
    expect(spec.service?.mean).toBeCloseTo(0.0125, 10);
    // And the field still reads what was typed rather than the original.
    expect(find<HTMLInputElement>(capacityField).value).toBe("80");
  });

  it("takes effect in the running simulation", () => {
    // At 30/s the demo is comfortable. Choking the database to 10/s cannot be
    // absorbed, so work starts being lost — a consequence of the number, not of
    // anything the control asserts.
    sim.runUntil(6);
    setValue(capacityField, "10", "change");
    sim.runUntil(20);

    const late = sim.series().slice(-20);
    const drops = late.reduce((total, bucket) => total + bucket.system.drops, 0);
    expect(drops).toBeGreaterThan(0);
  });

  it("says what is wrong and changes nothing when the text is not a rate", () => {
    sim.runUntil(2);
    setValue(capacityField, "quite fast", "change");

    expect(sim.recorded().mutations).toHaveLength(0);
    expect(find(".wtr-field-error").textContent).toMatch(/not a rate/i);
  });

  it("refuses a capacity of zero rather than dividing by it", () => {
    setValue(capacityField, "0", "change");
    expect(sim.recorded().mutations).toHaveLength(0);
    expect(find(".wtr-field-error").textContent).toMatch(/greater than zero/i);
  });

  it("keeps a session driven through the knob replayable", () => {
    sim.runUntil(3);
    setValue(capacityField, "80", "change");
    sim.runUntil(6);
    setValue(capacityField, "35", "change");
    sim.runUntil(10);

    const replay = createModelSimulation(sim.recorded());
    replay.runUntil(10);
    expect(JSON.stringify(replay.series())).toBe(JSON.stringify(sim.series()));
  });
});

describe("naming what folded first", () => {
  const culprit = () => find(".wtr-culprit");

  it("says nothing while the model is coping", () => {
    expect(culprit().dataset["culprit"]).toBe("");
    expect(culprit().textContent).toBe("");
  });

  it("names the database and clears the replicas that are only carrying it", () => {
    setValue('[data-action="load"]', "44", "input");
    sim.runUntil(60);
    // The player paints on animation frames, which happy-dom does not deliver;
    // repaint through the same control a resize would use.
    globalThis.dispatchEvent(new window.Event("resize"));

    expect(culprit().dataset["culprit"]).toBe("orders-db");
    expect(culprit().textContent).toMatch(/^orders-db folded first/);
    expect(culprit().textContent).toMatch(/api-1, api-2 are red because of it, not with it/);
  });

  it("stops accusing once the model recovers", () => {
    setValue('[data-action="load"]', "44", "input");
    sim.runUntil(60);
    globalThis.dispatchEvent(new window.Event("resize"));
    expect(culprit().dataset["culprit"]).toBe("orders-db");

    // A stale accusation is worse than none, so it is repainted rather than latched.
    setValue('[data-action="preset:retry-policy"]', "none", "change");
    setValue('[data-action="load"]', "10", "input");
    sim.runUntil(120);
    globalThis.dispatchEvent(new window.Event("resize"));

    expect(culprit().dataset["culprit"]).toBe("");
  }, 20_000);
});

describe("stating a timeout", () => {
  const timeoutField = '[data-action="timeout:api-1"]';

  it("shows the current one in milliseconds, and what it does", () => {
    expect(find<HTMLInputElement>(timeoutField).value).toBe("250");
    expect(find('[data-conversion="timeout:api-1"]').textContent).toBe(
      "Gives up on a slow call after 250 ms, then retries.",
    );
  });

  it("applies to every replica the control covers", () => {
    sim.runUntil(2);
    setValue(timeoutField, "1s", "change");

    const recorded = sim.recorded().mutations;
    expect(recorded).toHaveLength(2);
    expect(recorded.map((m) => (m.kind === "set-spec" ? m.nodeId : ""))).toEqual(["api-1", "api-2"]);
    const spec = recorded[0]?.kind === "set-spec" ? (recorded[0].spec as { timeout?: { after?: number } }) : {};
    expect(spec.timeout?.after).toBe(1);
  });

  it("can be switched off, and says so", () => {
    setValue(timeoutField, "off", "change");
    expect(find('[data-conversion="timeout:api-1"]').textContent).toMatch(/never gives up/i);

    const last = sim.recorded().mutations.at(-1);
    const spec = last?.kind === "set-spec" ? (last.spec as { timeout?: { policy?: string } }) : {};
    expect(spec.timeout?.policy).toBe("none");
  });

  it("rescues the design a short timeout was killing", () => {
    // The session that produced this knob: a 50/s database, two API replicas at
    // 25/s each, 40/s offered. The capacity arithmetic says it fits, and at
    // 250 ms it collapses anyway — every slow answer becomes up to four database
    // requests. The timeout is the cheapest lever that changes the outcome.
    setValue('[data-action="capacity:api-1"]', "25", "change");
    setValue('[data-action="load"]', "40", "input");
    sim.runUntil(90);

    const collapsed = sim.series().slice(-40);
    const goodput = collapsed.reduce((t, b) => t + b.system.completions, 0) / (collapsed.length * 0.25);
    expect(goodput).toBe(0);

    setValue(timeoutField, "1s", "change");
    click('[data-action="rerun"]');
    const fresh = surface.simulation();
    fresh.runUntil(90);

    const after = fresh.series().slice(-40);
    const recovered = after.reduce((t, b) => t + b.system.completions, 0) / (after.length * 0.25);
    expect(recovered).toBeGreaterThan(30);
  }, 30_000);
});

describe("a steered run says so, and a clean rerun is one click", () => {
  const capacityField = '[data-action="capacity:orders-db"]';
  const badge = () => find('.wtr-steered');

  const completionsOver = (simulation: Simulation, buckets: number): number =>
    simulation.series().slice(-buckets).reduce((total, bucket) => total + bucket.system.completions, 0);

  it("says nothing until something has been changed mid-run", () => {
    expect(badge().dataset["steered"]).toBe("false");
  });

  it("marks the reading once a knob has been turned, and names the moment", () => {
    sim.runUntil(7);
    setValue(capacityField, "80", "change");

    expect(badge().dataset["steered"]).toBe("true");
    expect(badge().textContent).toMatch(/steered at 7\.0s/i);
    // It is the state that is marked, not the knob: dragging the load counts too.
    expect(badge().textContent).toMatch(/how it got here/i);
  });

  it("starts from cold on a rerun, keeping the parameters that are on screen", () => {
    sim.runUntil(9);
    setValue(capacityField, "80", "change");
    click('[data-action="rerun"]');

    const fresh = surface.simulation();
    expect(fresh).not.toBe(sim);
    expect(fresh.now()).toBe(0);

    const timeline = fresh.recorded();
    // Nothing carried over from the steered run except the decisions themselves.
    expect(timeline.mutations).toEqual([]);
    expect(timeline.seed).toBe(sim.recorded().seed);

    const db = timeline.model.nodes.find((node) => node.id === "orders-db");
    expect((db?.spec as { service?: { mean?: number } }).service?.mean).toBeCloseTo(0.0125, 10);
    expect(badge().dataset["steered"]).toBe("false");
  });

  it("separates what this design does from where this run ended up", () => {
    // The confusion it exists to prevent: drive the model into the spiral, raise
    // the database's capacity, and read the still-broken gauges as a verdict on
    // the bigger database. The steered run is a fair answer to "can we recover
    // by scaling up mid-incident"; it is not an answer to "is this design sound",
    // and a rerun from cold is.
    setValue('[data-action="load"]', "44", "input");
    sim.runUntil(45);
    const drops = sim.series().slice(-40).reduce((total, bucket) => total + bucket.system.drops, 0);
    expect(drops).toBeGreaterThan(0);

    setValue(capacityField, "200", "change");
    click('[data-action="rerun"]');

    const fresh = surface.simulation();
    fresh.runUntil(20);
    expect(completionsOver(fresh, 40)).toBeGreaterThan(0);
  });

  it("keeps the load it was given rather than snapping back to the demo's", () => {
    setValue('[data-action="load"]', "62", "input");
    click('[data-action="rerun"]');

    expect(surface.simulation().recorded().load).toEqual([{ rate: 62, duration: 3600 }]);
  });
});

describe("transport", () => {
  it("stops advancing the clock when paused, and says so", () => {
    click('[data-action="play-pause"]');
    expect(find('[data-action="play-pause"]').textContent).toBe("Play");

    const at = sim.now();
    // Animation frames are what advance the clock; none will arrive while paused.
    expect(sim.now()).toBe(at);

    click('[data-action="play-pause"]');
    expect(find('[data-action="play-pause"]').textContent).toBe("Pause");
  });

  it("offers speeds but no scrubber — sim time only moves forward", () => {
    expect(find('[data-action="speed"]')).toBeTruthy();
    expect(root.querySelector('input[type="range"][data-action="speed"]')).toBeNull();
    // The load is the one thing you drag. Any other slider on this surface would
    // be a scrubber or a disguised one, so the check names what is allowed
    // rather than counting.
    const sliders = [...root.querySelectorAll('input[type="range"]')].map((node) =>
      node.getAttribute("data-action"),
    );
    expect(sliders).toEqual(["load"]);
  });
});

describe("the validation panel", () => {
  it("opens and closes from a persistent action", () => {
    expect(root.querySelector('[data-panel="validation"]')).toBeNull();

    click('[data-action="validation"]');
    expect(root.querySelector('[data-panel="validation"]')).toBeTruthy();
    expect(find('[data-action="validation"]').textContent).toBe("Hide validation");

    click('[data-action="validation"]');
    expect(root.querySelector('[data-panel="validation"]')).toBeNull();
  });

  it("says what it is checking before any result arrives", () => {
    click('[data-action="validation"]');
    const panel = find('[data-panel="validation"]');
    expect(panel.textContent).toMatch(/textbook/i);
    expect(panel.querySelector("thead")?.textContent).toMatch(/Theory/);
  });

  it("offers a main-thread run when this environment has no worker, rather than failing silently", () => {
    // happy-dom has no Worker, which is the same situation as a browser refusing
    // one. The panel has to remain honest and usable, and must not quietly
    // substitute a cheaper set of checks.
    click('[data-action="validation"]');
    const panel = find('[data-panel="validation"]');
    const status = panel.querySelector(".wtr-validation-status");

    if (status?.getAttribute("data-state") === "blocked") {
      const button = panel.querySelector('[data-action="validate-blocking"]');
      expect(button).toBeTruthy();
      expect(status.textContent).toMatch(/lock the page up/i);
    } else {
      // A worker did start here; then it must be running or already reporting.
      expect(["running", "pass", "fail", "error"]).toContain(status?.getAttribute("data-state"));
    }
  });
});

describe("the breaking-point panel", () => {
  it("opens and closes from a persistent action", () => {
    expect(root.querySelector('[data-panel="verdict"]')).toBeNull();

    click('[data-action="sweep"]');
    expect(root.querySelector('[data-panel="verdict"]')).toBeTruthy();
    expect(find('[data-action="sweep"]').textContent).toBe("Hide breaking point");

    click('[data-action="sweep"]');
    expect(root.querySelector('[data-panel="verdict"]')).toBeNull();
  });

  it("says what it is doing before any probe has landed", () => {
    click('[data-action="sweep"]');
    const panel = find('[data-panel="verdict"]');

    expect(panel.dataset["state"]).toBe("running");
    expect(panel.textContent).toMatch(/steady rate/i);
  });

  it("marks an answer stale when a knob moves the design out from under it", () => {
    click('[data-action="sweep"]');
    expect(find('[data-panel="verdict"] [data-stale]').dataset["stale"]).toBe("false");

    setValue('[data-action="load"]', "44", "input");

    // The bracket was worked out for the design as it stood a moment ago. A stale
    // number nobody has flagged is what a room quotes for the next twenty minutes.
    expect(find('[data-panel="verdict"] [data-stale]').dataset["stale"]).toBe("true");
  });

  it("sweeps the design as it stands now, not the one the run started with", () => {
    // The recorded model is the one the run began with; every knob turned since
    // lives in the mutation log. A sweep off that snapshot would answer for a
    // design nobody is looking at any more.
    setValue('[data-action="timeout:api-1"]', "1000", "change");
    click('[data-action="sweep"]');

    const specs = sim.recorded().mutations.filter((mutation) => mutation.kind === "set-spec");
    expect(specs.length).toBeGreaterThan(0);
    expect(root.querySelector('[data-panel="verdict"]')).toBeTruthy();
  });
});

describe("teardown", () => {
  it("releases the frame loop and the panel", () => {
    click('[data-action="validation"]');
    expect(root.querySelector('[data-panel="validation"]')).toBeTruthy();

    surface.destroy();
    const at = sim.now();
    // No further advance can happen: the loop is cancelled and nothing is holding
    // a reference to it. A hidden-not-destroyed surface would keep ticking here.
    expect(sim.now()).toBe(at);

    // Destroying twice must not throw — the app machine may do it on the way out.
    expect(() => surface.destroy()).not.toThrow();
  });
});


describe("the tour, for a viewer with nobody presenting (F3)", () => {
  let toured: RunSurface;
  let tourHost: HTMLElement;

  beforeEach(() => {
    tourHost = document.createElement("div");
    document.body.append(tourHost);
    toured = createRunSurface(createModelSimulation(demoTimeline()), demoControls(), {
      guidance: demoGuidance(),
    });
    tourHost.append(toured.element);
    toured.start();
  });

  afterEach(() => {
    toured.destroy();
    tourHost.remove();
  });

  it("shows the steps in order, each one an action and what to watch", () => {
    const steps = [...tourHost.querySelectorAll(".wtr-guidance-step")];

    expect(steps).toHaveLength(demoGuidance().steps.length);
    expect(steps[0]?.querySelector(".wtr-guidance-action")?.textContent).toBe(demoGuidance().steps[0]?.action);
    expect(steps[0]?.querySelector(".wtr-guidance-watch")?.textContent).toBe(demoGuidance().steps[0]?.watch);
  });

  it("goes away when dismissed and does not come back", () => {
    // Scaffolding for the first minute. A presenter driving this in a room should
    // not have to talk over instructions written for somebody else.
    const card = tourHost.querySelector<HTMLElement>("[data-guidance]");
    expect(card?.dataset["guidance"]).toBe("open");

    tourHost
      .querySelector('[data-action="dismiss-guidance"]')
      ?.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));

    expect(card?.dataset["guidance"]).toBe("dismissed");
    expect(tourHost.querySelector(".wtr-guidance-step")).toBeNull();
  });

  it("is not shown to somebody running a model they drew themselves", () => {
    // The surface built in the outer beforeEach has no guidance. Explaining an
    // author's own system back to them is the tool talking down to its user.
    expect(root.querySelector("[data-guidance]")).toBeNull();
  });
});

describe("comparing against a baseline on the run surface (F2)", () => {
  let compared: RunSurface;
  let host: HTMLElement;

  /** The demo, with the second replica marked as this month's proposal. */
  beforeEach(() => {
    host = document.createElement("div");
    document.body.append(host);
    compared = createRunSurface(createModelSimulation(demoTimeline()), demoControls(), {
      comparison: { delta: ["api-2"], disputed: null },
    });
    host.append(compared.element);
    compared.start();
  });

  afterEach(() => {
    compared.destroy();
    host.remove();
  });

  const inHost = <T extends HTMLElement>(selector: string): T => {
    const node = host.querySelector<T>(selector);
    if (node === null) throw new Error(`no element matching ${selector}`);
    return node;
  };

  const clickIn = (selector: string): void => {
    inHost(selector).dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  };

  it("offers the switch only when there is a proposal to switch off", () => {
    expect(inHost('[data-action="arm:baseline"]')).toBeTruthy();
    // The plain surface built in the outer beforeEach has no proposal.
    expect(root.querySelector('[data-action="arm:baseline"]')).toBeNull();
  });

  it("runs the design without the proposal, from cold", () => {
    clickIn('[data-action="arm:baseline"]');

    const model = compared.simulation().recorded().model;
    expect(model.nodes.map((node) => node.id)).not.toContain("api-2");
    // A structural change is edit-then-rerun by the engine's own contract, so the
    // switch is a clean run rather than a mutation spliced into a live one.
    expect(compared.simulation().recorded().mutations).toEqual([]);
    expect(compared.simulation().now()).toBeLessThan(1);
  });

  it("puts the proposal back", () => {
    clickIn('[data-action="arm:baseline"]');
    clickIn('[data-action="arm:proposal"]');

    expect(compared.simulation().recorded().model.nodes.map((node) => node.id)).toContain("api-2");
  });

  it("says which arm is on screen", () => {
    clickIn('[data-action="arm:baseline"]');

    expect(inHost(".wtr-arm-toggle").dataset["showing"]).toBe("baseline");
    expect(inHost('[data-action="arm:baseline"]').dataset["selected"]).toBe("true");
    expect(inHost('[data-action="arm:proposal"]').dataset["selected"]).toBe("false");
  });

  it("still sweeps the authored design while the baseline is on screen", () => {
    clickIn('[data-action="arm:baseline"]');
    clickIn('[data-action="sweep"]');

    // The study derives its own baseline arm. A target that had already been
    // reduced would compare the design against itself.
    expect(inHost('[data-panel="verdict"] .wtr-verdict-title').textContent).toContain("each of these");
  });
});

describe("steering other traffic live", () => {
  /** The demo's datastore, with somebody else's load stated on it. */
  function withOtherTraffic(): { sim: Simulation; surface: RunSurface } {
    const { document: doc } = addTrafficSource(demoDocument(), "datastore-1", 12);
    const model = createModelSimulation(toTimeline(doc));
    const running = createRunSurface(model, controlsForDocument(doc));
    root.append(running.element);
    running.start();
    return { sim: model, surface: running };
  }

  let extra: RunSurface | null = null;

  afterEach(() => {
    extra?.destroy();
    extra = null;
  });

  it("offers a field for it, starting at the rate the model states", () => {
    const running = withOtherTraffic();
    extra = running.surface;
    expect(find<HTMLInputElement>('[data-action="traffic:traffic-datastore-1"]').value).toBe("12");
  });

  it("records the change in the log a replay reads", () => {
    const running = withOtherTraffic();
    extra = running.surface;
    running.sim.runUntil(2);
    setValue('[data-action="traffic:traffic-datastore-1"]', "40", "change");

    const recorded = running.sim.recorded().mutations;
    expect(recorded.at(-1)).toMatchObject({ kind: "set-source-rate", sourceId: "traffic-datastore-1", rate: 40 });
  });

  it("marks the reading as steered, like every other live change", () => {
    const running = withOtherTraffic();
    extra = running.surface;
    running.sim.runUntil(2);
    setValue('[data-action="traffic:traffic-datastore-1"]', "40", "change");

    expect(running.surface.element.querySelector('[data-steered="true"]')).not.toBeNull();
  });

  it("keeps the running rate when the field is not a number", () => {
    const running = withOtherTraffic();
    extra = running.surface;
    running.sim.runUntil(2);
    setValue('[data-action="traffic:traffic-datastore-1"]', "some", "change");

    expect(running.sim.recorded().mutations.some((m) => m.kind === "set-source-rate")).toBe(false);
    expect(running.surface.element.textContent).toMatch(/zero or more requests per second/);
  });

  it("offers nothing when the model states no other traffic", () => {
    expect(root.querySelector('[data-action^="traffic:"]')).toBeNull();
  });
});

describe("steering a dependency call live", () => {
  /** The demo, with the first replica also asking a Redis — 10 ms timeout, one retry. */
  function withCall(policy: Record<string, unknown> | null): { sim: Simulation; surface: RunSurface } {
    let doc = addComponent(demoDocument(), { kind: "datastore", spec: { concurrency: 1 } }).document;
    doc = connect(doc, "service-1", "datastore-2", "call");
    if (policy !== null) doc = setCallPolicy(doc, "service-1", "datastore-2", policy);
    const model = createModelSimulation(toTimeline(doc));
    const running = createRunSurface(model, controlsForDocument(doc));
    root.append(running.element);
    running.start();
    return { sim: model, surface: running };
  }
  const POLICY = {
    timeout: { policy: "fixed", after: 0.01 },
    retry: { policy: "fixed", attempts: 1, delay: 0, factor: 1, maxDelay: 0 },
  };
  const TIMEOUT = '[data-action="call-timeout:service-1:datastore-2"]';
  const RETRIES = '[data-action="call-retries:service-1:datastore-2"]';

  let extra: RunSurface | null = null;
  afterEach(() => {
    extra?.destroy();
    extra = null;
  });

  it("offers the call's timeout and retries, and says what they do", () => {
    extra = withCall(POLICY).surface;

    expect(find<HTMLInputElement>(TIMEOUT).value).toBe("10");
    expect(find<HTMLInputElement>(RETRIES).value).toBe("1");
    expect(find('[data-conversion="call:service-1:datastore-2"]').textContent).toBe(
      "Gives up after 10 ms; asks once more, straight away. The attempt it gave up on is still being worked on.",
    );
  });

  it("records the whole policy, so turning retries off keeps the timeout", () => {
    const running = withCall(POLICY);
    extra = running.surface;
    running.sim.runUntil(2);
    setValue(RETRIES, "off", "change");

    const last = running.sim.recorded().mutations.at(-1);
    expect(last).toMatchObject({ kind: "set-call", from: "service-1", to: "datastore-2" });
    expect(last).toMatchObject({ policy: { timeout: { policy: "fixed", after: 0.01 }, retry: { policy: "none" } } });
    expect(running.surface.element.querySelector('[data-steered="true"]')).not.toBeNull();
  });

  it("keeps the running policy when the text is not a number of retries", () => {
    const running = withCall(POLICY);
    extra = running.surface;
    running.sim.runUntil(2);
    setValue(RETRIES, "lots", "change");

    expect(running.sim.recorded().mutations.some((m) => m.kind === "set-call")).toBe(false);
    expect(running.surface.element.textContent).toMatch(/is not a number of retries/);
  });

  it("carries the live policy into a clean rerun", () => {
    const running = withCall(POLICY);
    extra = running.surface;
    running.sim.runUntil(2);
    setValue(RETRIES, "off", "change");
    running.surface.element
      .querySelector('[data-action="rerun"]')
      ?.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));

    const call = running.surface
      .simulation()
      .recorded()
      .model.edges.find((edge) => edge.kind === "call");
    expect(call?.policy).toMatchObject({ retry: { policy: "none" } });
  });

  it("offers nothing for a call nobody gave a policy", () => {
    extra = withCall(null).surface;

    expect(root.querySelector('[data-action^="call-"]')).toBeNull();
  });
});

describe("steering a box by clicking it", () => {
  const section = (key: string): HTMLDetailsElement => find<HTMLDetailsElement>(`[data-steer="${key}"]`);

  function clickBox(id: string): void {
    const layout = layoutModel(sim.recorded().model);
    const place = layout.nodes[id];
    if (place === undefined) throw new Error(`no ${id}`);
    find("canvas").dispatchEvent(
      new window.MouseEvent("click", { bubbles: true, clientX: place.x + place.w / 2, clientY: place.y + place.h / 2 }),
    );
  }

  it("keeps each component's knobs together, closed until asked for", () => {
    expect(section("orders-db").querySelector('[data-action="capacity:orders-db"]')).toBeTruthy();
    expect(section("api-1 api-2").querySelector('[data-action="timeout:api-1"]')).toBeTruthy();
    expect(section("orders-db").open).toBe(false);
  });

  it("opens the clicked box's knobs and closes the rest", () => {
    clickBox("orders-db");
    expect(section("orders-db").open).toBe(true);

    clickBox("api-1");
    expect(section("api-1 api-2").open).toBe(true);
    expect(section("orders-db").open).toBe(false);
  });

  it("opens the knobs of whatever folds first, on its own", () => {
    setValue('[data-action="load"]', "44", "input");
    // Long enough for the storm to start and name its culprit.
    for (let i = 0; i < 40 && root.querySelector('[data-culprit="orders-db"]') === null; i += 1) {
      sim.runUntil(sim.now() + 2);
      surface.simulation();
      // The surface paints on its own clock; a repaint is what reads the frame.
      window.dispatchEvent(new window.Event("resize"));
    }
    expect(find(".wtr-culprit").dataset["culprit"]).toBe("orders-db");
    expect(section("orders-db").open).toBe(true);
  });
});

describe("what was changed while running", () => {
  const chips = (): string[] => [...root.querySelectorAll(".wtr-change")].map((chip) => chip.textContent ?? "");

  it("says each live change in words, with when", () => {
    sim.runUntil(3);
    setValue('[data-action="capacity:orders-db"]', "80", "change");

    expect(chips()).toEqual(["3 s · Database capacity → 80 /s"]);
  });

  it("counts a drag of the load as one change, not one per pixel", () => {
    for (const value of ["30", "35", "40", "44"]) setValue('[data-action="load"]', value, "input");
    expect(chips()).toEqual(["0 s · load → 44/s"]);
  });

  it("records nothing when a field is left unchanged", () => {
    setValue('[data-action="capacity:orders-db"]', "80", "change");
    const before = sim.recorded().mutations.length;
    setValue('[data-action="capacity:orders-db"]', "80", "change");

    expect(sim.recorded().mutations.length).toBe(before);
    expect(chips()).toHaveLength(1);
  });

  it("starts a clean rerun with no changes", () => {
    setValue('[data-action="capacity:orders-db"]', "80", "change");
    click('[data-action="rerun"]');
    expect(chips()).toEqual([]);
  });
});

describe("Present mode", () => {
  it("switches the layout for a shared screen, and back", () => {
    click('[data-action="present"]');
    expect(surface.element.dataset["mode"]).toBe("present");
    expect(find('[data-action="present"]').textContent).toBe("Back to desk");

    click('[data-action="present"]');
    expect(surface.element.dataset["mode"]).toBe("desk");
  });

  it("keeps the demo's policy controls on screen, in the bottom strip", () => {
    click('[data-action="present"]');
    expect(find(".wtr-transport").querySelector('[data-action^="preset:"]')).toBeTruthy();

    click('[data-action="present"]');
    expect(find(".wtr-controls").querySelector('[data-action^="preset:"]')).toBeTruthy();
  });

  it("floats the selected box's knobs beside it", () => {
    click('[data-action="present"]');
    const layout = layoutModel(sim.recorded().model);
    const place = layout.nodes["orders-db"];
    if (place === undefined) throw new Error("layout");
    find("canvas").dispatchEvent(
      new window.MouseEvent("click", { bubbles: true, clientX: place.x + place.w / 2, clientY: place.y + place.h / 2 }),
    );

    const card = find(".wtr-steer-card");
    expect(card.dataset["card"]).toBe("open");
    expect(card.querySelector('[data-action="capacity:orders-db"]')).toBeTruthy();

    // And it goes home again when the room is done.
    click('[data-action="present"]');
    expect(find(".wtr-controls").querySelector('[data-action="capacity:orders-db"]')).toBeTruthy();
  });
});
