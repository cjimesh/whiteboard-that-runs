// @vitest-environment happy-dom
/**
 * The two-surface machine.
 *
 * The claim worth testing is not that the surfaces appear — it is that the one
 * being left is *destroyed*. A hidden run surface keeps an animation frame loop
 * and a resize listener alive behind the editor, and the loop this exists to
 * support (edit, run, edit again) would leak one of each per pass.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mountApp, type AppHandle } from "./app.ts";

let root: HTMLElement;
let app: AppHandle;

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

const click = (selector: string): void => {
  const node = root.querySelector<HTMLElement>(selector);
  if (node === null) throw new Error(`no element matching ${selector}`);
  node.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
};

beforeEach(() => {
  stubCanvas();
  root = document.createElement("div");
  document.body.append(root);
});

afterEach(() => {
  app?.destroy();
  root.remove();
  vi.restoreAllMocks();
});

describe("which surface is up", () => {
  it("opens on the running demo, not on an empty canvas", () => {
    app = mountApp(root);

    expect(app.surface()).toBe("run");
    expect(root.querySelector('[data-surface="run"]')).toBeTruthy();
  });

  it("goes to the editor and back to a run, carrying the model both ways", () => {
    app = mountApp(root);

    click('[data-action="edit"]');
    expect(app.surface()).toBe("editor");
    // It opens on the demo as a document: the first thing anybody edits is the
    // system they were just watching fail.
    expect(root.querySelector('[data-action="add:app"]')).toBeTruthy();

    click('[data-action="run"]');
    expect(app.surface()).toBe("run");
    expect(root.querySelectorAll("[data-surface]")).toHaveLength(1);
  });

  it("destroys the surface it leaves rather than hiding it", () => {
    const cancels = vi.spyOn(globalThis, "cancelAnimationFrame");
    const removals = vi.spyOn(globalThis, "removeEventListener");

    app = mountApp(root);
    click('[data-action="edit"]');

    // The run surface's player and its resize listener are both gone.
    expect(cancels).toHaveBeenCalled();
    expect(removals.mock.calls.some(([type]) => type === "resize")).toBe(true);
    expect(root.querySelectorAll('[data-surface="run"]')).toHaveLength(0);
  });

  it("leaves nothing behind on destroy", () => {
    app = mountApp(root);
    app.destroy();

    expect(app.surface()).toBeNull();
    expect(root.children).toHaveLength(0);
  });
});

describe("running an authored model", () => {
  it("gives it the live knobs its own components deserve", () => {
    app = mountApp(root);
    click('[data-action="edit"]');
    click('[data-action="run"]');

    // The demo document has a datastore and two services, so the run surface
    // offers a capacity knob for each and a timeout for the services — derived
    // from the components, not declared anywhere.
    expect(root.querySelector('[data-action="capacity:datastore-1"]')).toBeTruthy();
    expect(root.querySelector('[data-action="capacity:service-1"]')).toBeTruthy();
    expect(root.querySelector('[data-action="timeout:service-1"]')).toBeTruthy();
    // A balancer has no service time and no timeout, so it gets neither.
    expect(root.querySelector('[data-action="capacity:balancer-1"]')).toBeNull();
  });
});

describe("a load pattern set in the editor", () => {
  const change = (selector: string, value: string): void => {
    const node = root.querySelector<HTMLInputElement | HTMLSelectElement>(selector);
    if (node === null) throw new Error(`no element matching ${selector}`);
    node.value = value;
    node.dispatchEvent(new window.Event("change", { bubbles: true }));
  };

  it("is the pattern the run starts on", () => {
    app = mountApp(root);
    click('[data-action="edit"]');
    change('[data-action="load-pattern"]', "spiky");
    click('[data-action="run"]');

    expect(root.querySelector<HTMLSelectElement>('[data-action="pattern"]')?.value).toBe("spiky");
    expect(root.querySelector<HTMLInputElement>('[data-action="pattern:height"]')?.value).toBe("3");
  });

  it("offers a typed schedule as Steps, scaled by the slider", () => {
    app = mountApp(root);
    click('[data-action="edit"]');
    change('[data-action="load-pattern"]', "steps");
    click('[data-action="run"]');

    const select = root.querySelector<HTMLSelectElement>('[data-action="pattern"]');
    expect(select?.value).toBe("steps");
    expect([...(select?.options ?? [])].map((option) => option.value)).toContain("steps");
    expect(root.querySelector("[data-pattern-summary]")?.textContent).toMatch(/until the schedule ends at 120 s/);
  });
});

describe("leaving with work nobody saved", () => {
  const leave = (): Event => {
    const event = new window.Event("beforeunload", { cancelable: true });
    window.dispatchEvent(event);
    return event;
  };

  it("lets the demo go without asking, edited by nobody", () => {
    app = mountApp(root);
    click('[data-action="edit"]');
    expect(app.unsaved()).toBe(false);
    expect(leave().defaultPrevented).toBe(false);
  });

  it("asks before closing over an edit, in the editor and after running it", () => {
    app = mountApp(root);
    click('[data-action="edit"]');
    click('[data-action="add:app"]');
    expect(app.unsaved()).toBe(true);
    expect(leave().defaultPrevented).toBe(true);

    // Undoing back to what was there leaves nothing to lose.
    click('[data-action="undo"]');
    expect(app.unsaved()).toBe(false);
  });

  it("stops asking once the model is saved", () => {
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:test");
    vi.spyOn(URL, "revokeObjectURL").mockReturnValue(undefined);
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockReturnValue(undefined);
    app = mountApp(root);
    click('[data-action="edit"]');
    click('[data-action="add:app"]');
    click('[data-action="save"]');
    expect(app.unsaved()).toBe(false);
    expect(leave().defaultPrevented).toBe(false);
  });

  it("still asks from the run surface about edits made before Run", () => {
    app = mountApp(root);
    click('[data-action="edit"]');
    // A rename: an edit that leaves the demo runnable.
    const name = root.querySelector<HTMLInputElement>('[data-action="name"]');
    if (name === null) throw new Error("no name field");
    name.value = "orders, revised";
    name.dispatchEvent(new window.Event("change", { bubbles: true }));
    click('[data-action="run"]');
    expect(app.surface()).toBe("run");
    expect(app.unsaved()).toBe(true);
  });

  it("removes its listener on destroy", () => {
    app = mountApp(root);
    click('[data-action="edit"]');
    click('[data-action="add:app"]');
    app.destroy();
    expect(leave().defaultPrevented).toBe(false);
  });
});
