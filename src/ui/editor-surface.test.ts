// @vitest-environment happy-dom
/**
 * The editor, driven the way an author drives it (F1).
 *
 * The flow under test is the one the product exists for: author a system, wire
 * it, set its parameters, compose its load, be refused when it is wrong, save
 * it, and open it again next month.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEditorSurface, type EditorSurface } from "./editor-surface.ts";
import { emptyDocument, toTimeline, type WhiteboardDocument } from "../model/document.ts";
import { emptyFrame, wireMidpoint } from "../view/frame.ts";
import { problemsByComponent } from "./editor-surface.ts";
import { serialize } from "../model/persist.ts";
import { layoutModel } from "../view/layout.ts";

let root: HTMLElement;
let surface: EditorSurface;
let ran: WhiteboardDocument[];

function stubCanvas(): void {
  const ctx = new Proxy(
    {},
    {
      // `measureText` has to return something shaped like TextMetrics: the
      // renderer measures a label to decide which side of a stub it fits on, and
      // a stub that answers `undefined` is not a fake canvas, it is a trap.
      get: (_target, key) => {
        if (key === "canvas") return undefined;
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

const click = (selector: string): void => {
  find(selector).dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
};

const setValue = (selector: string, value: string): void => {
  const node = find<HTMLInputElement | HTMLSelectElement>(selector);
  node.value = value;
  node.dispatchEvent(new window.Event("change", { bubbles: true }));
};

/**
 * Click a component on the canvas.
 *
 * The stubbed canvas is exactly the logical box, so layout coordinates are
 * client coordinates — the same layout the renderer would paint.
 */
function clickComponent(id: string): void {
  const layout = layoutModel(toTimeline(surface.document()).model);
  const place = layout.nodes[id];
  if (place === undefined) throw new Error(`no component ${id} in the layout`);
  find("canvas").dispatchEvent(
    new window.MouseEvent("click", {
      bubbles: true,
      clientX: place.x + place.w / 2,
      clientY: place.y + place.h / 2,
    }),
  );
}

const problems = (): string => find("[data-problems]").textContent ?? "";

beforeEach(() => {
  stubCanvas();
  root = document.createElement("div");
  document.body.append(root);
  ran = [];
  surface = createEditorSurface({ document: emptyDocument("test model"), onRun: (doc) => ran.push(doc) });
  root.append(surface.element);
  surface.start();
});

afterEach(() => {
  surface.destroy();
  root.remove();
});

/** Connect two components the way the button does: select, Sends requests to…, click the target. */
function connectWith(from: string, to: string): void {
  clickComponent(from);
  click('[data-action="connect"]');
  clickComponent(to);
}

/** Click the middle of an arrow on the canvas. */
function clickArrow(from: string, to: string): void {
  const frame = emptyFrame(toTimeline(surface.document()).model);
  const edge = frame.edges.find((candidate) => candidate.from === from && candidate.to === to);
  if (edge === undefined) throw new Error(`no arrow ${from} → ${to}`);
  const middle = wireMidpoint(edge);
  find("canvas").dispatchEvent(new window.MouseEvent("click", { bubbles: true, clientX: middle.x, clientY: middle.y }));
}

const relation = (): string | undefined =>
  root.querySelector<HTMLElement>('[data-action^="relation:"][data-selected="true"]')?.dataset["action"];

describe("authoring a system (F1)", () => {
  it("declares itself, so the automation contract holds", () => {
    expect(root.querySelector("[data-surface]")?.getAttribute("data-surface")).toBe("editor");
  });

  it("adds things by what they are, and names them readably", () => {
    click('[data-action="add:balancer"]');
    click('[data-action="add:app"]');
    click('[data-action="add:database"]');
    click('[data-action="add:memory-store"]');

    expect(surface.document().components.map((c) => c.id)).toEqual(["lb-1", "app-1", "db-1", "store-1"]);
    // What it is, kept even after its numbers are typed by hand.
    expect(surface.document().components.map((c) => c.archetype)).toEqual([
      "balancer",
      "app",
      "database",
      "memory-store",
    ]);
  });

  it("connects two components with the button: select one, then click the other", () => {
    click('[data-action="add:app"]');
    click('[data-action="add:database"]');
    connectWith("app-1", "db-1");

    expect(surface.document().edges).toEqual([{ from: "app-1", to: "db-1" }]);
  });

  it("connects two components by dragging from one to the other", () => {
    click('[data-action="add:app"]');
    click('[data-action="add:database"]');
    const layout = layoutModel(toTimeline(surface.document()).model);
    const a = layout.nodes["app-1"];
    const b = layout.nodes["db-1"];
    if (a === undefined || b === undefined) throw new Error("layout");

    const at = (place: typeof a) => ({ bubbles: true, clientX: place.x + place.w / 2, clientY: place.y + place.h / 2 });
    find("canvas").dispatchEvent(new window.MouseEvent("pointerdown", at(a)));
    globalThis.dispatchEvent(new window.MouseEvent("pointermove", at(b)));
    globalThis.dispatchEvent(new window.MouseEvent("pointerup", at(b)));

    expect(surface.document().edges).toEqual([{ from: "app-1", to: "db-1" }]);
    // And the new arrow is what is selected, so the next thing seen is its question.
    expect(find(".wtr-inspector .wtr-panel-title").textContent).toBe("app-1 → db-1");
  });

  it("catches an arrow drawn the wrong way round, and flips it in one click", () => {
    // The first person to use the editor did exactly this: added an app server,
    // "connected it to the load balancer" — which draws app → balancer — then
    // connected it to the database.
    click('[data-action="add:balancer"]');
    click('[data-action="add:app"]');
    click('[data-action="add:database"]');
    connectWith("app-1", "lb-1");
    expect(find("[data-backwards]").textContent).toMatch(/probably points the wrong way/);

    // Its arrow to the database is right, and is not blamed.
    click('[data-action="select-source"]');
    connectWith("app-1", "db-1");
    expect(root.querySelector("[data-backwards]")).toBeNull();

    clickArrow("app-1", "lb-1");
    expect(find('[data-action="flip"]').className).toMatch(/primary/);
    click('[data-action="flip"]');
    expect(surface.document().edges).toContainEqual({ from: "lb-1", to: "app-1" });
    expect(surface.document().edges.some((edge) => edge.from === "app-1" && edge.to === "lb-1")).toBe(false);
    expect(root.querySelector("[data-backwards]")).toBeNull();
    expect(problems()).not.toMatch(/app-1/);
  });

  it("says what it is waiting for while connecting", () => {
    click('[data-action="add:app"]');
    click('[data-action="add:database"]');
    clickComponent("app-1");
    click('[data-action="connect"]');

    expect(find("[data-hint]").dataset["hint"]).toBe("wiring");
    expect(find("[data-hint]").textContent).toMatch(/click the box app-1 sends requests to/i);
  });

  it("abandons a connection on Escape rather than trapping the author in a mode", () => {
    click('[data-action="add:app"]');
    click('[data-action="add:database"]');
    clickComponent("app-1");
    click('[data-action="connect"]');

    globalThis.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape" }));

    expect(find("[data-hint]").dataset["hint"]).toBe("");
    clickComponent("db-1");
    expect(surface.document().edges).toEqual([]);
  });

  it("says the time asked for is its own work, not counting what it waits on", () => {
    click('[data-action="add:app"]');
    click('[data-action="add:database"]');
    clickComponent("app-1");
    expect(find('[data-field="service-time"] .wtr-preset-note').textContent).toMatch(/Don't include time waiting on what it calls/);
    // A database calls nothing, so it is not told about waits it cannot have.
    clickComponent("db-1");
    expect(find('[data-field="service-time"] .wtr-preset-note').textContent).toBe("Its own work on one request, on average.");
  });

  it("asks the two questions up front, and nothing about calls on the box", () => {
    click('[data-action="add:database"]');
    clickComponent("db-1");

    expect(root.querySelector('[data-param="concurrency"]')).toBeTruthy();
    expect(root.querySelector('[data-param="service-time"]')).toBeTruthy();
    // Capacity is said, not typed: one fact, one input.
    expect(root.querySelector('[data-param="capacity"]')).toBeNull();
    expect(find('[data-capacity="db-1"]').textContent).toMatch(/^Can serve about 1,000 a second\./);
    // Timeouts and retries govern a call, so they are asked on the arrow.
    expect(root.querySelector('[data-param="timeout"]')).toBeNull();
    expect(root.querySelector('[data-param="retry-policy"]')).toBeNull();
  });

  it("keeps the archetype's other settings under Details", () => {
    click('[data-action="add:database"]');
    clickComponent("db-1");

    const details = find<HTMLDetailsElement>('[data-section="details"]');
    expect(details.open).toBe(false);
    expect(details.querySelector('[data-param="queue-capacity"]')).toBeTruthy();
    expect(details.querySelector('[data-action="preset"]')).toBeTruthy();
  });

  it("takes a time in milliseconds and says what it adds up to", () => {
    click('[data-action="add:database"]');
    clickComponent("db-1");
    setValue('[data-param="service-time"]', "200");

    // Ten connections at 200 ms each.
    expect(surface.document().components[0]?.spec.service?.mean).toBeCloseTo(0.2, 10);
    expect(find('[data-capacity="db-1"]').textContent).toMatch(/^Can serve about 50 a second\./);
  });

  it("asks the hold as a core question where there is a lease", () => {
    click('[data-action="add:session-pool"]');
    clickComponent("pool-1");

    expect(root.querySelector('.wtr-inspector > [data-field="hold-mean"]')).toBeTruthy();
    expect(find('[data-capacity="pool-1"]').textContent).toMatch(/each slot stays taken for 60 s/);
  });

  it("refuses a number it cannot read, and changes nothing", () => {
    click('[data-action="add:database"]');
    clickComponent("db-1");
    const before = surface.document();

    setValue('[data-param="service-time"]', "quickly");

    expect(find('[data-field="service-time"] .wtr-field-error').textContent).toMatch(/milliseconds/i);
    expect(surface.document()).toBe(before);
  });

  it("stops claiming a preset once its settings are edited by hand, but keeps what it is", () => {
    click('[data-action="add:app"]');
    clickComponent("app-1");
    setValue('[data-action="preset"]', "service/exponential-retry");
    expect(surface.document().components[0]?.preset).toBe("service/exponential-retry");

    setValue('[data-param="concurrency"]', "8");
    expect(surface.document().components[0]?.preset).toBeNull();
    expect(find(".wtr-inspector [data-kind]").textContent).toBe("App server");
  });

  it("composes a load pattern out of steps (R3)", () => {
    click('[data-action="add:app"]');
    click('[data-action="add-step"]');
    click('[data-action="add-step"]');

    setValue('[data-load-rate="0"]', "200");
    setValue('[data-load-duration="0"]', "120");
    setValue('[data-load-rate="1"]', "800");
    setValue('[data-load-duration="1"]', "30");
    setValue('[data-load-rate="2"]', "200");
    setValue('[data-load-duration="2"]', "120");

    expect(surface.document().load).toEqual([
      { rate: 200, duration: 120 },
      { rate: 800, duration: 30 },
      { rate: 200, duration: 120 },
    ]);
  });

  it("saves a spiky load with the model", () => {
    click('[data-action="add:app"]');
    setValue('[data-action="load-pattern"]', "spiky");
    setValue('[data-load-rate="0"]', "40");
    setValue('[data-action="pattern:height"]', "5");

    expect(surface.document().load).toEqual([{ rate: 40, duration: 3600 }]);
    expect(surface.document().pattern).toEqual({ kind: "spiky", height: 5, every: 20, lasting: 2 });
    expect(find("[data-pattern-summary]").textContent).toContain("peaks at 200/s");
  });

  it("refuses a bad pattern setting and keeps the one it had", () => {
    click('[data-action="add:app"]');
    setValue('[data-action="load-pattern"]', "formula");
    setValue('[data-action="pattern:formula"]', "fetch(1)");
    expect(find(".wtr-load .wtr-pattern-error").textContent).toContain('"fetch" is not a function');
    expect(surface.document().pattern).toEqual({ kind: "formula", text: "base * (1 + 0.5 * sin(2 * pi * t / 60))" });
  });

  it("gives a shape back its settings after a trip to steady", () => {
    click('[data-action="add:app"]');
    setValue('[data-action="load-pattern"]', "random");
    setValue('[data-action="pattern:spread"]', "20");
    setValue('[data-action="load-pattern"]', "steady");
    expect(surface.document().pattern).toBeUndefined();
    setValue('[data-action="load-pattern"]', "random");
    expect(surface.document().pattern).toEqual({ kind: "random", spread: 0.2, every: 5 });
  });

  it("removes a component and the arrows that pointed at it", () => {
    click('[data-action="add:app"]');
    click('[data-action="add:database"]');
    connectWith("app-1", "db-1");

    clickComponent("db-1");
    click('[data-action="delete"]');

    expect(surface.document().components.map((c) => c.id)).toEqual(["app-1"]);
    expect(surface.document().edges).toEqual([]);
  });

  it("renames a component, and every arrow follows", () => {
    click('[data-action="add:app"]');
    click('[data-action="add:memory-store"]');
    connectWith("app-1", "store-1");
    clickComponent("store-1");
    setValue('[data-action="rename"]', "session-redis");

    expect(surface.document().components.map((c) => c.id)).toEqual(["app-1", "session-redis"]);
    expect(surface.document().edges).toEqual([{ from: "app-1", to: "session-redis" }]);
    expect(find<HTMLInputElement>('[data-action="rename"]').value).toBe("session-redis");
  });

  it("refuses a name another component already has", () => {
    click('[data-action="add:app"]');
    click('[data-action="add:app"]');
    clickComponent("app-2");
    setValue('[data-action="rename"]', "app-1");

    expect(surface.document().components.map((c) => c.id)).toEqual(["app-1", "app-2"]);
  });
});

describe("starting from a shape, and undoing it", () => {
  it("offers common shapes, and starts one running-ready", () => {
    click('[data-action="new"]');
    expect(find("[data-chooser]").dataset["chooser"]).toBe("open");
    click('[data-action="shape:web-database"]');

    expect(surface.document().components.map((c) => c.id)).toEqual(["lb-1", "app-1", "app-2", "db-1"]);
    expect(find<HTMLButtonElement>('[data-action="run"]').disabled).toBe(false);
    expect(find("[data-chooser]").dataset["chooser"]).toBe("closed");
  });

  it("gets the previous model back with Undo, and forward again with Redo", () => {
    click('[data-action="add:app"]');
    const mine = surface.document();
    click('[data-action="new"]');
    click('[data-action="shape:cache"]');

    click('[data-action="undo"]');
    expect(surface.document()).toBe(mine);
    click('[data-action="redo"]');
    expect(surface.document().name).toBe("A cache in front of a database");
  });

  it("undoes with the keyboard, but not while a field is being typed in", () => {
    click('[data-action="add:app"]');
    click('[data-action="add:database"]');
    globalThis.dispatchEvent(new window.KeyboardEvent("keydown", { key: "z", ctrlKey: true }));
    expect(surface.document().components.map((c) => c.id)).toEqual(["app-1"]);

    const field = find<HTMLInputElement>('[data-action="name"]');
    field.dispatchEvent(new window.KeyboardEvent("keydown", { key: "z", ctrlKey: true, bubbles: true }));
    expect(surface.document().components.map((c) => c.id)).toEqual(["app-1"]);
  });
});

describe("what an arrow means", () => {
  function appAndDatabase(): void {
    click('[data-action="add:app"]');
    click('[data-action="add:database"]');
    connectWith("app-1", "db-1");
  }

  it("asks what the sender does with the receiver, starting from the usual answer", () => {
    appAndDatabase();
    clickArrow("app-1", "db-1");

    expect(find(".wtr-question").textContent).toBe("What does app-1 do with db-1?");
    expect(relation()).toBe("relation:forward-wait");
  });

  it("makes it a hand-off that does not wait", () => {
    appAndDatabase();
    clickArrow("app-1", "db-1");
    click('[data-action="relation:forward-handoff"]');

    expect(surface.document().components[0]?.spec.downstream?.policy).toBe("fire-and-forget");
    expect(relation()).toBe("relation:forward-handoff");
    // Nothing waits, so there is nothing to time out.
    expect(root.querySelector("[data-arrow-timeout]")).toBeNull();
  });

  it("makes it something asked along the way, with a count per request", () => {
    appAndDatabase();
    clickArrow("app-1", "db-1");
    click('[data-action="relation:call"]');

    expect(surface.document().edges).toEqual([{ from: "app-1", to: "db-1", kind: "call", times: 1 }]);
    setValue("[data-arrow-times]", "20");
    expect(surface.document().edges[0]?.times).toBe(20);
  });

  it("asks timeout and retries on the arrow, and they land on the sender for a hand-off", () => {
    appAndDatabase();
    clickArrow("app-1", "db-1");
    setValue("[data-arrow-timeout]", "250");
    setValue("[data-arrow-retries]", "2");

    const spec = surface.document().components[0]?.spec;
    expect(spec?.timeout).toEqual({ policy: "fixed", after: 0.25 });
    expect(spec?.retry).toMatchObject({ policy: "fixed", attempts: 2 });
    expect(find("[data-arrow-policy]").textContent).toMatch(/^Gives up after 250 ms; asks up to 2 more times/);
  });

  it("makes a second arrow out of a component something it asks, since work goes one place", () => {
    click('[data-action="add:app"]');
    click('[data-action="add:database"]');
    click('[data-action="add:memory-store"]');
    connectWith("app-1", "db-1");
    connectWith("app-1", "store-1");

    expect(surface.document().edges[1]).toEqual({ from: "app-1", to: "store-1", kind: "call", times: 1 });
    expect(find<HTMLButtonElement>('[data-action="run"]').disabled).toBe(false);
  });

  it("lists a box's arrows, each a way into its questions", () => {
    appAndDatabase();
    clickComponent("app-1");
    click('[data-action="select-arrow:db-1"]');

    expect(find(".wtr-inspector .wtr-panel-title").textContent).toBe("app-1 → db-1");
  });

  it("removes an arrow from the arrow itself", () => {
    appAndDatabase();
    clickArrow("app-1", "db-1");
    click('[data-action="unwire"]');

    expect(surface.document().edges).toEqual([]);
  });
});

describe("stating a dependency call's timeout and retry", () => {
  /** An app that hands work to a database and also asks an in-memory store. */
  const depends = (): void => {
    click('[data-action="add:app"]');
    click('[data-action="add:database"]');
    click('[data-action="add:memory-store"]');
    connectWith("app-1", "db-1");
    connectWith("app-1", "store-1");
  };
  const call = () => surface.document().edges.find((edge) => edge.kind === "call");

  it("starts a call with neither, and saves nothing for it", () => {
    depends();

    expect(find<HTMLInputElement>("[data-arrow-timeout]").value).toBe("off");
    expect(find<HTMLInputElement>("[data-arrow-retries]").value).toBe("off");
    expect(call()?.policy).toBeUndefined();
  });

  it("takes a timeout and a retry count, and says what the call now does", () => {
    depends();
    setValue("[data-arrow-timeout]", "50");
    setValue("[data-arrow-retries]", "1");

    expect(call()?.policy).toMatchObject({
      timeout: { policy: "fixed", after: 0.05 },
      retry: { policy: "fixed", attempts: 1 },
    });
    expect(find("[data-arrow-policy]").textContent).toMatch(/^Gives up after 50 ms; asks once more/);
    expect(problems()).toBe("");
  });

  it("asks how it retries only once it does: the first wait and a budget, both stated", () => {
    depends();
    expect(root.querySelector("[data-arrow-retry-budget]")).toBeNull();

    setValue("[data-arrow-retries]", "3");
    expect(find<HTMLInputElement>("[data-arrow-retry-delay]").value).toBe("100");
    setValue("[data-arrow-retry-delay]", "250");
    setValue("[data-arrow-retry-budget]", "10");

    expect(call()?.policy).toMatchObject({ retry: { attempts: 3, delay: 0.25, budget: 0.1 } });
    expect(find("[data-arrow-policy]").textContent).toMatch(/250 ms apart\. Retries are capped at 10% of requests/);
    expect(problems()).toBe("");
  });

  it("puts a hand-off's retry budget on the sender", () => {
    depends();
    clickArrow("app-1", "db-1");
    setValue("[data-arrow-timeout]", "250");
    setValue("[data-arrow-retries]", "3");
    setValue("[data-arrow-retry-budget]", "20%");

    expect(surface.document().components[0]?.spec.retry).toMatchObject({ attempts: 3, budget: 0.2 });
  });

  it("refuses text that is not a duration, and changes nothing", () => {
    depends();
    setValue("[data-arrow-timeout]", "soon");

    expect(call()?.policy).toBeUndefined();
    expect(root.textContent).toMatch(/is not a duration/);
  });
});

describe("guesses are visible", () => {
  it("starts every number as assumed, and says so on the box and in the list", () => {
    click('[data-action="add:database"]');
    clickComponent("db-1");

    expect(find('[data-action="provenance:concurrency"]').dataset["provenance"]).toBe("assumed");
    expect(find('[data-section="assumptions"] summary').textContent).toBe(
      "Guesses: 2 numbers nobody has confirmed",
    );
  });

  it("counts a typed number as stated", () => {
    click('[data-action="add:database"]');
    clickComponent("db-1");
    setValue('[data-param="concurrency"]', "30");

    expect(surface.document().components[0]?.provenance).toEqual({ concurrency: "stated" });
    expect(find('[data-action="provenance:concurrency"]').dataset["provenance"]).toBe("stated");
  });

  it("cycles assumed, stated, measured, and back", () => {
    click('[data-action="add:database"]');
    clickComponent("db-1");
    click('[data-action="provenance:service-time"]');
    click('[data-action="provenance:service-time"]');
    expect(surface.document().components[0]?.provenance).toEqual({ "service-time": "measured" });

    click('[data-action="provenance:service-time"]');
    expect(surface.document().components[0]?.provenance).toBeUndefined();
  });

  it("confirms a guess straight from the list", () => {
    click('[data-action="add:database"]');
    click('[data-action="confirm:db-1:concurrency"]');

    expect(surface.document().components[0]?.provenance).toEqual({ concurrency: "stated" });
  });
});

describe("refusing to run what cannot run", () => {
  const runButton = (): HTMLButtonElement => find<HTMLButtonElement>('[data-action="run"]');

  it("will not run an empty model, and says why", () => {
    expect(runButton().disabled).toBe(true);
    expect(problems()).toMatch(/empty/i);
  });

  it("names the component nobody wired, on the list and on its box", () => {
    click('[data-action="add:app"]');
    click('[data-action="add:database"]');

    expect(runButton().disabled).toBe(true);
    expect(problems()).toMatch(/"app-1" is not wired to anything/);
    expect([...problemsByComponent(surface.document()).keys()]).toContain("app-1");
    clickComponent("app-1");
    expect(find('[data-component-problem="app-1"]').textContent).toMatch(/not wired to anything/);
  });

  it("refuses a loop with no way out", () => {
    click('[data-action="add:app"]');
    click('[data-action="add:app"]');
    connectWith("app-1", "app-2");
    connectWith("app-2", "app-1");

    expect(problems()).toMatch(/loop with no way out/);
    expect(runButton().disabled).toBe(true);
  });

  it("hands a runnable model to the run surface", () => {
    click('[data-action="add:app"]');
    click('[data-action="add:database"]');
    connectWith("app-1", "db-1");

    expect(runButton().disabled).toBe(false);
    click('[data-action="run"]');

    expect(ran).toHaveLength(1);
    expect(ran[0]?.components.map((c) => c.id)).toEqual(["app-1", "db-1"]);
  });

  it("does nothing on Run while the model is refused", () => {
    click('[data-action="add:app"]');
    click('[data-action="add:database"]');
    click('[data-action="run"]');
    expect(ran).toEqual([]);
  });
});

describe("opening a saved model", () => {
  const drop = (text: string): Promise<void> => {
    const event = new window.Event("drop", { bubbles: true }) as Event & { dataTransfer: unknown };
    Object.defineProperty(event, "dataTransfer", {
      value: { files: [{ text: () => Promise.resolve(text) }] },
    });
    surface.element.dispatchEvent(event);
    // The handler reads the file asynchronously.
    return Promise.resolve().then(() => undefined);
  };

  it("replaces the editor's model with the file's, and undo brings the old one back", async () => {
    let saved = emptyDocument("last month");
    saved = { ...saved, components: [{ id: "db", kind: "datastore", preset: null, spec: {} }], entryId: "db" };

    await drop(serialize(saved));
    await vi.waitFor(() => expect(surface.document().name).toBe("last month"));
    expect(surface.document().components.map((c) => c.id)).toEqual(["db"]);

    click('[data-action="undo"]');
    expect(surface.document().name).toBe("test model");
  });

  it("keeps the author's work when the file cannot be read", async () => {
    click('[data-action="add:app"]');
    const before = surface.document();

    await drop("{ not really json");
    await vi.waitFor(() => expect(problems()).toMatch(/not JSON/i));

    expect(problems()).toMatch(/Nothing was changed/);
    expect(surface.document()).toBe(before);
  });
});

describe("what the inspector says a component is", () => {
  it("names what each palette entry is, alongside the engine kind it runs as", () => {
    for (const [action, id, kind, label] of [
      ["app", "app-1", "service", "App server"],
      ["queue", "queue-1", "queue", "Queue + workers"],
      ["balancer", "lb-1", "balancer", "Load balancer"],
      ["cache", "cache-1", "cache", "Cache"],
      ["database", "db-1", "datastore", "Database"],
      ["memory-store", "store-1", "datastore", "In-memory store"],
      ["session-pool", "pool-1", "datastore", "Session pool"],
    ] as const) {
      click(`[data-action="add:${action}"]`);
      clickComponent(id);

      const tag = find<HTMLElement>(".wtr-inspector [data-kind]");
      expect(tag.dataset["kind"]).toBe(kind);
      expect(tag.textContent).toBe(label);
    }
  });

  it("names a component from an older file by its kind", () => {
    surface.destroy();
    root.replaceChildren();
    const old = { ...emptyDocument(), components: [{ id: "orders", kind: "datastore" as const, preset: null, spec: {} }], entryId: "orders" };
    surface = createEditorSurface({ document: old, onRun: () => undefined });
    root.append(surface.element);
    surface.start();
    clickComponent("orders");

    expect(find(".wtr-inspector [data-kind]").textContent).toBe("Datastore");
  });
});

describe("marking this month's proposal (R9)", () => {
  /** A balancer, an app and a database, with a cache inserted in front of the database. */
  function systemWithCache(): void {
    click('[data-action="add:balancer"]');
    click('[data-action="add:app"]');
    click('[data-action="add:database"]');
    click('[data-action="add:cache"]');
    connectWith("lb-1", "app-1");
    connectWith("app-1", "cache-1");
    connectWith("cache-1", "db-1");
  }

  it("marks a component and says so on the button", () => {
    systemWithCache();
    clickComponent("cache-1");

    expect(find('[data-action="proposal"]').dataset["marked"]).toBe("false");
    click('[data-action="proposal"]');

    expect(surface.document().delta).toEqual(["cache-1"]);
    expect(find('[data-action="proposal"]').dataset["marked"]).toBe("true");
    expect(find('[data-action="proposal"]').textContent).toContain("New in this proposal ✓");
  });

  it("takes the mark off again", () => {
    systemWithCache();
    clickComponent("cache-1");
    click('[data-action="proposal"]');
    click('[data-action="proposal"]');

    expect(surface.document().delta).toEqual([]);
  });

  it("refuses to run a model whose proposal is the entry point", () => {
    systemWithCache();
    clickComponent("lb-1");
    click('[data-action="proposal"]');

    expect(problems()).toMatch(/entry point.*cannot be part of the proposal/);
    expect(find<HTMLButtonElement>('[data-action="run"]').disabled).toBe(true);
  });

  it("carries the marks through to the run", () => {
    systemWithCache();
    clickComponent("cache-1");
    click('[data-action="proposal"]');
    click('[data-action="run"]');

    expect(ran[0]?.delta).toEqual(["cache-1"]);
  });
});

describe("disputing a number (R10)", () => {
  function databaseSelected(): void {
    click('[data-action="add:database"]');
    clickComponent("db-1");
  }

  it("is offered on numbers and not on policies", () => {
    databaseSelected();

    expect(root.querySelector('[data-action="dispute:service-time"]')).toBeTruthy();
    // A range over a policy name is not a range.
    expect(root.querySelector('[data-action="dispute:queue-policy"]')).toBeNull();
  });

  it("opens a range around the value that is already there", () => {
    databaseSelected();
    setValue('[data-param="service-time"]', "50");
    click('[data-action="dispute:service-time"]');

    expect(surface.document().disputed).toEqual({ componentId: "db-1", field: "service-time", min: 40, max: 60 });
    expect(find<HTMLInputElement>('[data-dispute="min"]').value).toBe("40");
    expect(find<HTMLInputElement>('[data-dispute="max"]').value).toBe("60");
  });

  it("takes the ends the author types", () => {
    databaseSelected();
    click('[data-action="dispute:service-time"]');
    setValue('[data-dispute="min"]', "5");

    expect(surface.document().disputed?.min).toBe(5);
  });

  it("says what is wrong rather than storing a range nothing can use", () => {
    databaseSelected();
    setValue('[data-param="service-time"]', "50");
    click('[data-action="dispute:service-time"]');
    setValue('[data-dispute="max"]', "10");

    expect(problems()).toMatch(/low end has to be below the high end/);
    expect(find<HTMLButtonElement>('[data-action="run"]').disabled).toBe(true);
  });

  it("stops disputing when the author agrees again", () => {
    databaseSelected();
    click('[data-action="dispute:service-time"]');
    click('[data-action="dispute:service-time"]');

    expect(surface.document().disputed).toBeNull();
    expect(root.querySelector('[data-dispute="min"]')).toBeNull();
  });
});

describe("stating other traffic on a shared component", () => {
  /** An app in front of a database, with the database selected. */
  const shared = (): void => {
    click('[data-action="add:app"]');
    click('[data-action="add:database"]');
    connectWith("app-1", "db-1");
    clickComponent("db-1");
  };

  it("offers it on a component nothing is wired out of", () => {
    shared();
    expect(root.querySelector('[data-action="add-traffic:db-1"]')).not.toBeNull();
  });

  it("does not offer it on a component that hands work on", () => {
    shared();
    clickComponent("app-1");
    expect(root.querySelector('[data-action="add-traffic:app-1"]')).toBeNull();
  });

  it("takes a rate, and the model stays runnable", () => {
    shared();
    click('[data-action="add-traffic:db-1"]');
    setValue('[data-traffic-rate="traffic-db-1"]', "45");

    expect(surface.document().sources).toEqual([
      { id: "traffic-db-1", name: "other traffic on db-1", nodeId: "db-1", rate: 45 },
    ]);
    expect(problems()).not.toMatch(/other traffic/i);
  });

  it("names what the traffic is, because a rate on its own says nothing", () => {
    shared();
    click('[data-action="add-traffic:db-1"]');
    setValue('[data-traffic-name="traffic-db-1"]', "reporting and the nightly export");

    expect(surface.document().sources[0]?.name).toBe("reporting and the nightly export");
  });

  it("keeps the traffic reachable after the component is wired onward, and says why", () => {
    shared();
    click('[data-action="add-traffic:db-1"]');
    setValue('[data-traffic-rate="traffic-db-1"]', "45");

    click('[data-action="add:cache"]');
    connectWith("db-1", "cache-1");
    clickComponent("db-1");

    expect(problems()).toMatch(/hands work on to something else/);
    click('[data-action="remove-traffic:traffic-db-1"]');
    expect(surface.document().sources).toEqual([]);
    expect(problems()).not.toMatch(/hands work on to something else/);
  });

  it("refuses a rate that is not a number, by name", () => {
    shared();
    click('[data-action="add-traffic:db-1"]');
    setValue('[data-traffic-rate="traffic-db-1"]', "lots");
    expect(problems()).toMatch(/other traffic on db-1.*per second/i);
  });
});
