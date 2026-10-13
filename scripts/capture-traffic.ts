/**
 * Captures other traffic into `docs/` — the editor control, and the canvas mark.
 *
 * Other traffic is the one thing on this canvas that arrives along no wire, so
 * whether it reads as *load arriving* rather than as a stray swatch parked under
 * a box is a question only an eye can settle. The first drawing was a 22-wide,
 * 16-tall bar, which at the widest ribbon scale is very nearly a square — the
 * tests were perfectly happy with it, and the picture was not.
 *
 * The demo model: these frames are committed, and a demo database with an
 * invented neighbour gives nothing away.
 *
 * Captured against the shipped `dist/index.html` over `file://`, like every
 * other frame here.
 */
import "../tooling-env.ts";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright";
import { LAYOUT_BOX, layoutModel } from "../src/view/layout.ts";
import { computeViewport } from "../src/view/renderer.ts";
import { toTimeline } from "../src/model/document.ts";
import { demoDocument } from "../src/ui/demo.ts";

const root = resolve(import.meta.dirname, "..");
const docsDir = resolve(root, "docs");
const target = `file://${resolve(root, "dist/index.html")}`;

async function main(): Promise<void> {
  await mkdir(docsDir, { recursive: true });

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

  const failures: string[] = [];
  page.on("pageerror", (error) => failures.push(String(error)));

  await page.goto(target);
  await page.locator('[data-surface="run"]').waitFor();
  await page.locator('[data-action="edit"]').click();
  await page.locator('[data-surface="editor"]').waitFor();

  // The demo's datastore: nothing is wired out of it, so it is what can carry
  // somebody else's load.
  const box = await page.locator("canvas").boundingBox();
  if (box === null) throw new Error("no canvas");
  const { scale, offsetX, offsetY } = computeViewport(box.width, box.height, LAYOUT_BOX);
  const place = layoutModel(toTimeline(demoDocument()).model, LAYOUT_BOX).nodes["datastore-1"];
  if (place === undefined) throw new Error("no datastore-1 in the layout");
  await page.mouse.click(
    box.x + offsetX + (place.x + place.w / 2) * scale,
    box.y + offsetY + (place.y + place.h / 2) * scale,
  );

  await page.locator('[data-action="add-traffic:datastore-1"]').click();
  const rate = page.locator('[data-traffic-rate="traffic-datastore-1"]');
  await rate.fill("18");
  await rate.dispatchEvent("change");

  await page.locator(".wtr-inspector").screenshot({ path: resolve(docsDir, "traffic-1-editor.png") });
  console.log("docs/traffic-1-editor.png");

  // The stated rate on the canvas, before anything has run: an input, like
  // capacity, not a measurement.
  await page.locator(".wtr-stage").screenshot({ path: resolve(docsDir, "traffic-2-stated.png") });
  console.log("docs/traffic-2-stated.png");

  await page.locator('[data-action="run"]').click();
  await page.locator('[data-surface="run"]').waitFor();
  await page.selectOption('[data-action="speed"]', "4");
  await page.waitForTimeout(9_000);

  await page.locator(".wtr-stage").screenshot({ path: resolve(docsDir, "traffic-3-running.png") });
  console.log("docs/traffic-3-running.png");

  await page.locator(".wtr-controls").screenshot({ path: resolve(docsDir, "traffic-4-knob.png") });
  console.log("docs/traffic-4-knob.png");

  await browser.close();
  if (failures.length > 0) {
    console.error(`page errors:\n  ${failures.join("\n  ")}`);
    process.exitCode = 1;
  }
}

await main();
