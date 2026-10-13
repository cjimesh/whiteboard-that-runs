/**
 * Captures the question-first editor into `docs/` — a starting shape, a box's
 * questions, an arrow's question, and the run.
 *
 * The editor was rebuilt around asking in the author's words; whether it reads
 * that way is a question for an eye, not a test. Captured against the shipped
 * `dist/index.html` over `file://`, like every other frame here.
 */
import "../tooling-env.ts";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium, type Page } from "playwright";
import { LAYOUT_BOX, layoutModel } from "../src/view/layout.ts";
import { computeViewport } from "../src/view/renderer.ts";
import { emptyFrame } from "../src/view/frame.ts";
import { toTimeline, type WhiteboardDocument } from "../src/model/document.ts";
import { STARTING_SHAPES } from "../src/ui/starting-shapes.ts";

const root = resolve(import.meta.dirname, "..");
const docsDir = resolve(root, "docs");
const target = `file://${resolve(root, "dist/index.html")}`;

async function toScreen(page: Page, x: number, y: number): Promise<{ x: number; y: number }> {
  const box = await page.locator("canvas").boundingBox();
  if (box === null) throw new Error("no canvas");
  const { scale, offsetX, offsetY } = computeViewport(box.width, box.height, LAYOUT_BOX);
  return { x: box.x + offsetX + x * scale, y: box.y + offsetY + y * scale };
}

async function clickComponent(page: Page, doc: WhiteboardDocument, id: string): Promise<void> {
  const place = layoutModel(toTimeline(doc).model, LAYOUT_BOX).nodes[id];
  if (place === undefined) throw new Error(`no ${id}`);
  const at = await toScreen(page, place.x + place.w / 2, place.y + place.h / 2);
  await page.mouse.click(at.x, at.y);
}

async function clickArrow(page: Page, doc: WhiteboardDocument, from: string, to: string): Promise<void> {
  const edge = emptyFrame(toTimeline(doc).model, LAYOUT_BOX).edges.find((e) => e.from === from && e.to === to);
  if (edge === undefined) throw new Error(`no arrow ${from} → ${to}`);
  const at = await toScreen(page, (edge.x1 + edge.x2) / 2, (edge.y1 + edge.y2) / 2);
  await page.mouse.click(at.x, at.y);
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

  await page.locator('[data-action="new"]').click();
  await page.screenshot({ path: resolve(docsDir, "ux-1-start-from.png") });
  console.log("docs/ux-1-start-from.png");

  await page.locator('[data-action="shape:shared-store"]').click();
  const doc = STARTING_SHAPES.find((shape) => shape.id === "shared-store")?.build();
  if (doc === undefined) throw new Error("no shape");

  await clickComponent(page, doc, "db-1");
  await page.screenshot({ path: resolve(docsDir, "ux-2-box.png") });
  console.log("docs/ux-2-box.png");

  await clickArrow(page, doc, "app-1", "store-1");
  await page.screenshot({ path: resolve(docsDir, "ux-3-arrow.png") });
  console.log("docs/ux-3-arrow.png");

  // The run, from the shape just drawn: click a box to steer it.
  await page.locator('[data-action="run"]').click();
  await page.locator('[data-surface="run"]').waitFor();
  await page.waitForTimeout(2_000);
  await clickComponent(page, doc, "store-1");
  await page.screenshot({ path: resolve(docsDir, "ux-4-run-desk.png") });
  console.log("docs/ux-4-run-desk.png");

  // Present mode, on the demo in its retry storm: the database that folded first
  // should be outlined with its knobs already beside it, nobody having asked.
  await page.goto(target);
  await page.locator('[data-surface="run"]').waitFor();
  await page.selectOption('[data-action="speed"]', "4");
  await page.locator('[data-action="load"]').evaluate((el: HTMLInputElement) => {
    el.value = "44";
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await page.locator('[data-action="present"]').click();
  await page.locator('.wtr-steer-card[data-card="open"]').waitFor({ timeout: 60_000 });
  await page.waitForTimeout(4_000);
  await page.screenshot({ path: resolve(docsDir, "ux-5-present.png") });
  console.log("docs/ux-5-present.png");

  await browser.close();
  if (failures.length > 0) {
    console.error(`page errors:\n  ${failures.join("\n  ")}`);
    process.exitCode = 1;
  }
}

await main();
