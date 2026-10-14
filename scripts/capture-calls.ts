/**
 * Captures a dependency call's timeout and retry into `docs/` — the editor row
 * and the live control.
 *
 * Both put two more fields and a sentence on a row that already held a name, a
 * count and a remove button, which is the kind of crowding a passing test never
 * sees. The demo model, with an invented Redis beside it: these frames are
 * committed.
 *
 * Captured against the shipped `dist/index.html` over `file://`, like every
 * other frame here.
 */
import "../tooling-env.ts";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium, type Page } from "playwright";
import { LAYOUT_BOX, layoutModel } from "../src/view/layout.ts";
import { computeViewport } from "../src/view/renderer.ts";
import { addComponent, connect, toTimeline, type WhiteboardDocument } from "../src/model/document.ts";
import { demoDocument } from "../src/ui/demo.ts";

const root = resolve(import.meta.dirname, "..");
const docsDir = resolve(root, "docs");
const target = `file://${resolve(root, "dist/index.html")}`;

async function clickComponent(page: Page, doc: WhiteboardDocument, id: string): Promise<void> {
  const box = await page.locator("canvas").boundingBox();
  if (box === null) throw new Error("no canvas");
  const { scale, offsetX, offsetY } = computeViewport(box.width, box.height, LAYOUT_BOX);
  const place = layoutModel(toTimeline(doc).model, LAYOUT_BOX).nodes[id];
  if (place === undefined) throw new Error(`no ${id} in the layout`);
  await page.mouse.click(
    box.x + offsetX + (place.x + place.w / 2) * scale,
    box.y + offsetY + (place.y + place.h / 2) * scale,
  );
}

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

  // Mirror what the clicks do to the document, so the layout used to find each
  // box on the canvas is the layout the editor is showing. The demo's app already
  // hands its work to the database, so a second arrow out of it is something it
  // asks along the way — the editor's default, and what is wanted here.
  let doc = addComponent(demoDocument(), { kind: "datastore", idBase: "store" }).document;
  await page.locator('[data-action="add:memory-store"]').click();
  await clickComponent(page, doc, "api-1");
  await page.locator('[data-action="connect"]').click();
  await clickComponent(page, doc, "store-1");
  doc = connect(doc, "api-1", "store-1", "call");

  const timeout = page.locator('[data-arrow-timeout="store-1"]');
  await timeout.fill("10");
  await timeout.dispatchEvent("change");
  const retries = page.locator('[data-arrow-retries="store-1"]');
  await retries.fill("1");
  await retries.dispatchEvent("change");

  await page.locator(".wtr-inspector").screenshot({ path: resolve(docsDir, "calls-1-editor.png") });
  console.log("docs/calls-1-editor.png");

  await page.locator('[data-action="run"]').click();
  await page.locator('[data-surface="run"]').waitFor();
  await page.selectOption('[data-action="speed"]', "4");
  await clickComponent(page, doc, "api-1");
  await page.waitForTimeout(3_000);

  const knob = page.locator('[data-steer="api-1"]');
  await knob.scrollIntoViewIfNeeded();
  await knob.screenshot({ path: resolve(docsDir, "calls-2-knob.png") });
  console.log("docs/calls-2-knob.png");

  await browser.close();
  if (failures.length > 0) {
    console.error(`page errors:\n  ${failures.join("\n  ")}`);
    process.exitCode = 1;
  }
}

await main();
