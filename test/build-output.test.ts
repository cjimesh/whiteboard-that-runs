import "../tooling-env.ts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { build } from "vite";
import { chromium, type Browser, type Locator, type Page } from "playwright";
import { PINNED_CSP, assertPinnedCsp } from "../csp.ts";
import { LAYOUT_BOX, layoutModel } from "../src/view/layout.ts";
import { computeViewport } from "../src/view/renderer.ts";
import { addComponent, connect, toTimeline } from "../src/model/document.ts";
import { demoDocument } from "../src/ui/demo.ts";
import type { ModelSnapshot } from "../src/engine/timeline.ts";

/**
 * The shipped artifact's two structural promises, asserted against a real build:
 *
 *   R11 — one self-contained HTML file that runs from the filesystem, offline,
 *         with no backend and no telemetry.
 *   R11 — the pinned zero-egress CSP, first in <head>.
 *
 * Both are properties of `dist/`, not of the source, so this test builds. It is
 * written at U1 and inherited by every later unit as a regression gate: the day
 * something starts reaching for the network, this is what fails.
 */

// Vitest runs with the project root as cwd; `import.meta.url` is not a file URL
// under the happy-dom environment, so it cannot be used to locate the build.
const projectRoot = process.cwd();
const distDir = resolve(projectRoot, "dist");

let distFiles: string[];
let html: string;

beforeAll(async () => {
  await build({ root: projectRoot, logLevel: "warn" });
  distFiles = await readdir(distDir, { recursive: true });
  html = await readFile(`${distDir}/index.html`, "utf8");
}, 120_000);


/**
 * Open a component's knobs the way a driver does: by its section in the column.
 * Each component's knobs start closed (only the selected or failing box is open),
 * so a test that types into one has to open it first, as a person would.
 */
async function openSteer(page: Page, key: string): Promise<void> {
  const section = page.locator(`[data-steer="${key}"]`);
  if (!(await section.evaluate((node) => (node as HTMLDetailsElement).open))) {
    await section.locator("summary").click();
  }
}

describe("single-file build (R11)", () => {
  it("emits exactly one file", () => {
    expect(distFiles).toEqual(["index.html"]);
  });

  it("inlines all script and style, leaving nothing to fetch", () => {
    // Any src/href pointing at a sibling asset would break the offline file.
    const externalRefs = [...html.matchAll(/<(?:script|link)\b[^>]*>/gi)]
      .map((m) => m[0])
      .filter((tag) => /\b(?:src|href)=/i.test(tag));

    expect(externalRefs).toEqual([]);
    expect(html).toMatch(/<script[^>]*>[\s\S]+<\/script>/);
  });

  it("declares no absolute network URLs anywhere in the bundle", () => {
    const urls = [...html.matchAll(/\bhttps?:\/\/[^\s"'`<>)]+/gi)].map((m) => m[0]);
    // Namespace/spec URLs (e.g. w3.org SVG) are inert identifiers, never fetched.
    const fetchable = urls.filter((u) => !u.startsWith("http://www.w3.org/"));

    expect(fetchable).toEqual([]);
  });

  it("runs from a real browser loading the file off disk, with every request blocked", async () => {
    const browser = await chromium.launch();
    const context = await browser.newContext();

    // Nothing should be requested at all; anything that is gets refused and
    // recorded, so a silent dependency on the network cannot pass unnoticed.
    const attempted: string[] = [];
    await context.route("**/*", (route) => {
      const url = route.request().url();
      if (url.startsWith("file://")) {
        void route.continue();
        return;
      }
      attempted.push(url);
      void route.abort();
    });

    const page = await context.newPage();
    try {
      await page.goto(`file://${distDir}/index.html`);
      // Waits on something script rendered, so a bundle that failed to execute
      // under the pinned CSP fails here rather than passing on static HTML.
      await expect.poll(() => page.locator("[data-surface]").count()).toBe(1);

      expect(attempted).toEqual([]);
    } finally {
      await browser.close();
    }
  }, 60_000);
});

/**
 * The shipped file, driven the way a person drives it.
 *
 * Everything below runs against `dist/index.html` opened off the filesystem with
 * every non-`file://` request aborted. That combination is the point: these are
 * the promises the artifact makes to somebody who was *sent the file*, and a
 * double-clicked page has an opaque origin where several things behave differently
 * from a hosted one. Discovering that in a review room is the failure this test
 * exists to prevent.
 */
describe("the artifact a stranger opens", () => {
  let browser: Browser;
  let page: Page;
  let attempted: string[];

  const readout = (label: string): Locator =>
    page.locator(".wtr-readout", { has: page.locator(".wtr-readout-label", { hasText: label }) })
      .locator(".wtr-readout-value");

  const rateOf = async (label: string): Promise<number> =>
    Number((await readout(label).textContent())?.replace("/s", "") ?? "NaN");

  beforeAll(async () => {
    browser = await chromium.launch();
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });

    attempted = [];
    await context.route("**/*", (route) => {
      const url = route.request().url();
      if (url.startsWith("file://") || url.startsWith("blob:") || url.startsWith("data:")) {
        void route.continue();
        return;
      }
      attempted.push(url);
      void route.abort();
    });

    page = await context.newPage();
    await page.goto(`file://${distDir}/index.html`);
    await page.locator('[data-surface="run"]').waitFor();
    // Fast-forward: sim seconds per wall second, so the arc does not take a minute.
    await page.selectOption('[data-action="speed"]', "4");
  }, 120_000);

  afterAll(async () => {
    await browser?.close();
  });

  it("runs the model on a canvas, unprompted", async () => {
    await expect.poll(async () => await rateOf("completing"), { timeout: 20_000 }).toBeGreaterThan(10);

    const colours = await page.evaluate(() => {
      const canvas = document.querySelector("canvas") as HTMLCanvasElement;
      const ctx = canvas.getContext("2d")!;
      const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const seen = new Set<string>();
      for (let i = 0; i < data.length; i += 4) seen.add(`${data[i]},${data[i + 1]},${data[i + 2]}`);
      return seen.size;
    });
    expect(colours).toBeGreaterThan(20);
  }, 60_000);

  it("gives the model most of the window, however many knobs are on the page", async () => {
    // The regression this exists for: controls used to stack under the canvas,
    // so each new parameter came out of the picture. One capacity field took it
    // to its floor. The canvas is the product — it holds the height, and the
    // parameters scroll beside it.
    const canvas = await page.locator("canvas").boundingBox();
    const viewport = page.viewportSize();
    expect(canvas).not.toBeNull();
    expect(viewport).not.toBeNull();

    expect(canvas!.height).toBeGreaterThan(viewport!.height * 0.55);
    expect(canvas!.width).toBeGreaterThan(viewport!.width * 0.55);

    // And the controls are reachable without scrolling the page itself — a
    // driver hunting for the load slider mid-sentence is a broken demo.
    const load = await page.locator('[data-action="load"]').boundingBox();
    expect(load!.y + load!.height).toBeLessThanOrEqual(viewport!.height);
  }, 60_000);

  it("collapses into a retry storm when the load is dragged past capacity, and recovers on one live change (AE1)", async () => {
    // Dragged to 44/s: a rate the database would handle fine on its own. The
    // timeouts and retries are what take it down, and nothing in the page scripted
    // that — it is the model's own arithmetic.
    await page.locator('[data-action="load"]').evaluate((el: HTMLInputElement) => {
      el.value = "44";
      el.dispatchEvent(new Event("input", { bubbles: true }));
    });

    await expect.poll(async () => await rateOf("completing"), { timeout: 40_000 }).toBe(0);
    expect(await rateOf("lost")).toBeGreaterThan(0);

    // Four boxes go red and only one is the cause. Without this line the room
    // argues about whichever red box is nearest.
    const culprit = page.locator(".wtr-culprit");
    await expect.poll(async () => await culprit.getAttribute("data-culprit")).toBe("orders-db");
    expect(await culprit.textContent()).toMatch(/red because of it, not with it/);

    // One preset change, mid-run, no restart.
    await page.selectOption('[data-action="preset:database-queue"]', "shed");
    await expect.poll(async () => await rateOf("completing"), { timeout: 40_000 }).toBeGreaterThan(20);

    expect(attempted).toEqual([]);
  }, 150_000);

  it("lets a stated capacity be typed in the units a reviewer speaks, and obeys it (R1)", async () => {
    // Picks up where AE1 left off: 44/s offered, the database shedding, throughput
    // back but bounded by the one connection. Saying the database is bigger than
    // that is a sentence — "it does two hundred a second" — and the run has to
    // move because of it.
    await openSteer(page, "orders-db");
    const field = page.locator('[data-action="capacity:orders-db"]');
    await expect.poll(async () => await field.inputValue()).toBe("50");

    await field.fill("200");
    await field.dispatchEvent("change");

    // The conversion is on screen, so nobody has to take the arithmetic on trust.
    await expect.poll(async () => await page.locator('[data-conversion="capacity:orders-db"]').textContent()).toBe(
      "200/s ⇒ 5 ms × 1 connection",
    );

    // A database that can serve five times the offered load serves all of it.
    await expect.poll(async () => await rateOf("completing"), { timeout: 40_000 }).toBeGreaterThan(35);
    await expect.poll(async () => await rateOf("lost"), { timeout: 40_000 }).toBe(0);

    expect(attempted).toEqual([]);
  }, 150_000);

  it("marks a steered reading and reruns the same design from cold on request", async () => {
    // By now the page has been driven into a spiral and steered out of it, so
    // the numbers on screen are a fair answer to "can we recover from here" and
    // not to "is this design sound". The badge says so, and the rerun answers
    // the other question with the same parameters, load and seed.
    const badge = page.locator(".wtr-steered");
    await expect.poll(async () => await badge.getAttribute("data-steered")).toBe("true");
    expect(await badge.textContent()).toMatch(/how it got here/i);

    await page.locator('[data-action="rerun"]').click();

    await expect.poll(async () => await badge.getAttribute("data-steered")).toBe("false");
    // A design with five times the offered load in database capacity serves it
    // all from cold, which is the claim the steered gauges could not make.
    await expect.poll(async () => await rateOf("completing"), { timeout: 40_000 }).toBeGreaterThan(35);

    expect(attempted).toEqual([]);
  }, 120_000);

  it("exposes the timeout in milliseconds, the cheapest lever on this model", async () => {
    await openSteer(page, "api-1 api-2");
    const field = page.locator('[data-action="timeout:api-1"]');
    await expect.poll(async () => await field.inputValue()).toBe("250");

    await field.fill("1s");
    await field.dispatchEvent("change");

    await expect.poll(async () => await page.locator('[data-conversion="timeout:api-1"]').textContent()).toBe(
      "Gives up on a slow call after 1 s, then retries.",
    );
    expect(attempted).toEqual([]);
  }, 60_000);

  it("greets a first-time viewer with the tour, and lets them dismiss it (F3)", async () => {
    // The first thing anybody sent this file sees. Asserted in the shipped
    // artifact because that is the only place the claim is about: a tour that
    // rendered in development and not off `file://` would fail for exactly the
    // people it exists for.
    const tour = page.locator("[data-guidance]");
    expect(await tour.getAttribute("data-guidance")).toBe("open");

    const steps = page.locator(".wtr-guidance-step");
    expect(await steps.count()).toBe(5);
    expect(await steps.first().textContent()).toContain("Drag Load to 44/s");

    await page.locator('[data-action="dismiss-guidance"]').click();
    await expect.poll(async () => await tour.getAttribute("data-guidance")).toBe("dismissed");

    expect(attempted).toEqual([]);
  }, 60_000);

  it("runs the queueing-theory checks in a worker, off a file:// page (R13)", async () => {
    // The reason this is asserted on the shipped file rather than in a unit test:
    // the worker is inlined and started from a blob URL, and a `file://` page has
    // an opaque origin. A module worker is refused there while a classic one is
    // not — so this is the test that would have caught the wrong worker format,
    // and it is the one that keeps catching it.
    await page.locator('[data-action="validation"]').click();
    const status = page.locator(".wtr-validation-status");

    // Generous, and it has been raised once: the suite grew three lease points
    // when the hold concern arrived, one of which is a 1,000-slot pool. What is
    // being tested here is that a worker starts and finishes off a `file://`
    // page, not how fast the machine running CI happens to be.
    await expect.poll(async () => await status.getAttribute("data-state"), { timeout: 150_000 }).not.toBe(
      "running",
    );
    // "blocked" would mean no worker was available and the page fell back to
    // offering a main-thread run. On the shipped artifact that is a regression.
    expect(await status.getAttribute("data-state")).toBe("pass");

    const rows = page.locator(".wtr-validation-table tbody tr");
    expect(await rows.count()).toBeGreaterThanOrEqual(12);
    await expect.poll(async () => await page.locator(".wtr-row-fail").count()).toBe(0);

    const first = await rows.first().textContent();
    expect(first).toMatch(/M\/M\/1/);
    expect(first).toMatch(/pass/);

    expect(attempted).toEqual([]);
  }, 180_000);

  it("brackets the breaking point in a worker, off a file:// page (R10)", async () => {
    // The sweep is the second thing that runs in the inlined worker, and it is the
    // one a room waits on, so it is asserted in the shipped file for the same
    // reason the validation suite is: a worker that will not start over `file://`
    // fails here and nowhere else.
    await page.locator('[data-action="sweep"]').click();
    const panel = page.locator('[data-panel="verdict"]');

    await expect.poll(async () => await panel.getAttribute("data-state"), { timeout: 120_000 }).not.toBe(
      "running",
    );
    expect(await panel.getAttribute("data-state")).toBe("done");

    // Probe rows arrive as messages from the worker. On a main-thread fallback the
    // rows would be filled in at the end instead, so their arrival is also the
    // evidence that the worker really carried the work.
    const rows = page.locator(".wtr-verdict-table tbody tr");
    expect(await rows.count()).toBeGreaterThanOrEqual(3);

    // The demo system is metastable, so the honest answer for it is that it has no
    // clean threshold — see `sweep.ts`. Either shape is a real answer; a blank one
    // is not.
    const headline = await page.locator("[data-headline]").textContent();
    expect(headline).toMatch(/Holds to|Holds beyond|No clean breaking point|Folds even/);
    expect(await page.locator("[data-headline]").getAttribute("data-headline")).not.toBe("error");

    expect(attempted).toEqual([]);
  }, 180_000);
});

describe("pinned CSP (R11)", () => {
  it("ships the exact pinned policy as the first element in <head>", () => {
    const result = assertPinnedCsp(html);
    expect(result.failures).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("permits no network destination", () => {
    expect(PINNED_CSP).toContain("default-src 'none'");
    expect(PINNED_CSP).toContain("connect-src 'none'");
    expect(PINNED_CSP).toContain("form-action 'none'");
    // A host source anywhere would open an egress channel.
    expect(PINNED_CSP).not.toMatch(/https?:/);
    expect(PINNED_CSP).not.toMatch(/\*/);
  });

  it("permits workers only from blob: — inlined code, never a fetched script", () => {
    // The sweep worker (U7) is inlined and instantiated from a blob URL. `blob:`
    // is same-origin data the page already holds, so this stays zero-egress;
    // a http(s) or wildcard worker source would not, and the assertion above
    // would catch it.
    expect(PINNED_CSP).toContain("worker-src blob:");
  });
});

/**
 * F1 end to end, in the shipped file: author, wire, run, save.
 *
 * Its own browser context rather than the driven page above, because this is a
 * cold-open flow — what somebody does the first time they decide to model their
 * own system rather than watch the demo.
 *
 * Component positions are computed here with the same derived layout the editor
 * paints, then mapped through the same viewport fit the renderer uses. Clicking
 * the canvas *is* the wiring interaction, so a test that faked it would leave
 * the load-bearing part of this surface unexercised.
 */
describe("authoring a system in the shipped file (F1)", () => {
  let browser: Browser;
  let page: Page;
  let attempted: string[];
  let pageErrors: string[];

  const clickComponent = async (model: ModelSnapshot, id: string): Promise<void> => {
    const box = await page.locator("canvas").boundingBox();
    if (box === null) throw new Error("no canvas");
    const { scale, offsetX, offsetY } = computeViewport(box.width, box.height, LAYOUT_BOX);
    const place = layoutModel(model, LAYOUT_BOX).nodes[id];
    if (place === undefined) throw new Error(`no component ${id}`);

    await page.mouse.click(
      box.x + offsetX + (place.x + place.w / 2) * scale,
      box.y + offsetY + (place.y + place.h / 2) * scale,
    );
  };

  beforeAll(async () => {
    browser = await chromium.launch();
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      acceptDownloads: true,
    });

    attempted = [];
    pageErrors = [];
    await context.route("**/*", (route) => {
      const url = route.request().url();
      if (url.startsWith("file://") || url.startsWith("blob:") || url.startsWith("data:")) {
        void route.continue();
        return;
      }
      attempted.push(url);
      void route.abort();
    });

    page = await context.newPage();
    // A thrown exception mid-render leaves the page looking merely wrong rather
    // than broken: `dataset["load-rate"]` threw here and passed in happy-dom,
    // which left a refused model with its Run button still enabled.
    page.on("pageerror", (error) => pageErrors.push(error.message));

    await page.goto(`file://${distDir}/index.html`);
    await page.locator('[data-surface="run"]').waitFor();
  }, 120_000);

  afterAll(async () => {
    await browser?.close();
  });

  it("opens the editor on the system that was just running", async () => {
    await page.locator('[data-action="edit"]').click();
    await page.locator('[data-surface="editor"]').waitFor();

    await expect.poll(async () => await page.locator('[data-action="run"]').isDisabled()).toBe(false);
    expect(pageErrors).toEqual([]);
  }, 60_000);

  it("refuses a component nobody wired, and names it", async () => {
    await page.locator('[data-action="add:cache"]').click();

    await expect.poll(async () => await page.locator('[data-action="run"]').isDisabled()).toBe(true);
    await expect
      .poll(async () => await page.locator("[data-problems]").textContent())
      .toMatch(/"cache-1" is not wired to anything/);
    expect(pageErrors).toEqual([]);
  }, 60_000);

  it("wires it by clicking the canvas, and then the model runs", async () => {
    // A cache in front of the datastore, which is how somebody would actually
    // add one. Wiring it to `service-1` instead would be refused, and correctly:
    // a service sends to one place, and fan-out is the balancer's job.
    const withCache = addComponent(demoDocument(), { kind: "cache" }).document;

    await clickComponent(toTimeline(withCache).model, "balancer-1");
    await page.locator('[data-action="connect"]').click();
    await clickComponent(toTimeline(withCache).model, "cache-1");

    // Adding that wire re-ranks the graph, so the second wire has to be clicked
    // against the picture the author is now looking at.
    const fedByBalancer = connect(withCache, "balancer-1", "cache-1");
    await clickComponent(toTimeline(fedByBalancer).model, "cache-1");
    await page.locator('[data-action="connect"]').click();
    await clickComponent(toTimeline(fedByBalancer).model, "datastore-1");

    await expect.poll(async () => await page.locator('[data-action="run"]').isDisabled()).toBe(false);

    await page.locator('[data-action="run"]').click();
    await page.locator('[data-surface="run"]').waitFor();

    // A real run of the authored model: knobs derived from its own components,
    // and work completing.
    await expect.poll(() => page.locator('[data-action="capacity:cache-1"]').count()).toBe(1);
    const completing = page
      .locator(".wtr-readout", { has: page.locator(".wtr-readout-label", { hasText: "completing" }) })
      .locator(".wtr-readout-value");
    await expect
      .poll(async () => Number((await completing.textContent())?.replace("/s", "") ?? "NaN"), { timeout: 30_000 })
      .toBeGreaterThan(0);

    expect(pageErrors).toEqual([]);
    expect(attempted).toEqual([]);
  }, 120_000);

  it("marks the cache as the proposal and reports both breaking points (AE5)", async () => {
    // The structural challenge, end to end in the shipped file: somebody in the
    // room says "does the cache actually buy us anything", and the answer is two
    // brackets from one model rather than two models kept in step by hand.
    await page.locator('[data-action="edit"]').click();
    await page.locator('[data-surface="editor"]').waitFor();

    const withCache = connect(addComponent(demoDocument(), { kind: "cache" }).document, "balancer-1", "cache-1");
    await clickComponent(toTimeline(withCache).model, "cache-1");
    await page.locator('[data-action="proposal"]').click();
    await expect.poll(async () => await page.locator('[data-action="proposal"]').getAttribute("data-marked")).toBe(
      "true",
    );

    await page.locator('[data-action="run"]').click();
    await page.locator('[data-surface="run"]').waitFor();

    // The live switch: the same load, the same seed, the design without its
    // proposal. Structural change is edit-then-rerun by the engine's contract, so
    // this is a clean run rather than a mutation spliced into a live one.
    await page.locator('[data-action="arm:baseline"]').click();
    await expect.poll(async () => await page.locator(".wtr-arm-toggle").getAttribute("data-showing")).toBe("baseline");
    await page.locator('[data-action="arm:proposal"]').click();

    await page.locator('[data-action="sweep"]').click();
    const panel = page.locator('[data-panel="verdict"]');
    await expect.poll(async () => await panel.getAttribute("data-state"), { timeout: 180_000 }).toBe("done");

    // Two arms, each with its own probes — and both really ran, which is what
    // proves the worker carried a four-way study and not just the first sweep.
    const arms = page.locator("[data-arm]");
    expect(await arms.count()).toBe(2);
    expect(await page.locator('[data-arm="Proposal"] tbody tr').count()).toBeGreaterThan(1);
    expect(await page.locator('[data-arm="Baseline"] tbody tr').count()).toBeGreaterThan(1);

    const headline = await page.locator("[data-headline]").textContent();
    expect(headline).toMatch(/proposal|Not every arm|cannot be compared/i);

    expect(pageErrors).toEqual([]);
    expect(attempted).toEqual([]);
  }, 300_000);

  it("states other traffic on a shared component, and runs with it", async () => {
    // The browser-only half of this feature. happy-dom accepts DOM misuse that
    // Chrome throws on — a `dataset` key that is not camelCase aborted a render
    // once and left Run enabled on an invalid model — so the fields here are
    // driven in a real browser, off a `file://` page, with page errors collected.
    await page.locator('[data-action="edit"]').click();
    await page.locator('[data-surface="editor"]').waitFor();

    const authored = connect(
      connect(addComponent(demoDocument(), { kind: "cache" }).document, "balancer-1", "cache-1"),
      "cache-1",
      "datastore-1",
    );

    // The datastore is what nothing is wired out of, so it is what can carry
    // somebody else's load.
    await clickComponent(toTimeline(authored).model, "datastore-1");
    await page.locator('[data-action="add-traffic:datastore-1"]').click();

    const rate = page.locator('[data-traffic-rate="traffic-datastore-1"]');
    await rate.fill("15");
    await rate.dispatchEvent("change");

    // Not a wire and not a component: the model is still runnable.
    await expect.poll(async () => await page.locator('[data-action="run"]').isDisabled()).toBe(false);

    await page.locator('[data-action="run"]').click();
    await page.locator('[data-surface="run"]').waitFor();

    // The live knob is derived from the model, like every other knob here.
    const knob = page.locator('[data-action="traffic:traffic-datastore-1"]');
    await expect.poll(async () => await knob.count()).toBe(1);
    await openSteer(page, "datastore-1");
    expect(await knob.inputValue()).toBe("15");

    // And it steers: turning the neighbour off is the question "what does this
    // design do with the spine to itself", asked without stopping the run.
    await knob.fill("0");
    await knob.dispatchEvent("change");
    await expect
      .poll(async () => await page.locator(".wtr-steered").getAttribute("data-steered"))
      .toBe("true");

    expect(pageErrors).toEqual([]);
    expect(attempted).toEqual([]);
  }, 120_000);

  it("saves the model as a file, under the pinned CSP", async () => {
    await page.locator('[data-action="edit"]').click();
    await page.locator('[data-surface="editor"]').waitFor();

    const download = page.waitForEvent("download", { timeout: 20_000 });
    await page.locator('[data-action="save"]').click();
    const file = await download;

    expect(file.suggestedFilename()).toMatch(/\.whiteboard\.json$/);
    expect(pageErrors).toEqual([]);
    expect(attempted).toEqual([]);
  }, 60_000);
});
