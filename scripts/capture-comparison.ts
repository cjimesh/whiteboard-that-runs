/**
 * Captures a comparison into `docs/`: a proposal, a disputed number, and four
 * brackets.
 *
 * The single-sweep panel is captured by `capture-verdict.ts`. This one exists
 * because the comparison is where the panel gets long — four arms, each with its
 * own claim and its own probe log — and whether that still reads as an argument
 * or has become a wall of numbers is a question no test can answer.
 *
 * Driven through the editor rather than assembled in code, so what is
 * photographed is the sequence somebody actually performs: add the thing, mark
 * it as the proposal, say which number is disputed, run.
 */
import "../tooling-env.ts";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium, type Page } from "playwright";
import { LAYOUT_BOX, layoutModel } from "../src/view/layout.ts";
import { computeViewport } from "../src/view/renderer.ts";
import { addComponent, connect, toTimeline } from "../src/model/document.ts";
import { demoDocument } from "../src/ui/demo.ts";
import type { ModelSnapshot } from "../src/engine/timeline.ts";

const root = resolve(import.meta.dirname, "..");
const docsDir = resolve(root, "docs");
const target = `file://${resolve(root, "dist/index.html")}`;

async function clickComponent(page: Page, model: ModelSnapshot, id: string): Promise<void> {
  const box = await page.locator("canvas").boundingBox();
  if (box === null) throw new Error("no canvas");
  const { scale, offsetX, offsetY } = computeViewport(box.width, box.height, LAYOUT_BOX);
  const place = layoutModel(model, LAYOUT_BOX).nodes[id];
  if (place === undefined) throw new Error(`no component ${id}`);
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

  // A cache in front of the datastore: the proposal somebody actually brings.
  const withCache = addComponent(demoDocument(), { kind: "cache" }).document;
  await page.locator('[data-action="add:cache"]').click();
  await clickComponent(page, toTimeline(withCache).model, "gateway");
  await page.locator('[data-action="connect"]').click();
  await clickComponent(page, toTimeline(withCache).model, "cache-1");

  const fedByBalancer = connect(withCache, "gateway", "cache-1");
  await clickComponent(page, toTimeline(fedByBalancer).model, "cache-1");
  await page.locator('[data-action="connect"]').click();
  await clickComponent(page, toTimeline(fedByBalancer).model, "orders-db");

  await clickComponent(page, toTimeline(fedByBalancer).model, "cache-1");
  await page.locator('[data-action="proposal"]').click();

  // And the number the room does not agree on.
  await clickComponent(page, toTimeline(fedByBalancer).model, "orders-db");
  await page.locator('[data-action="dispute:service-time"]').click();
  await page.locator('.wtr-inspector').screenshot({ path: resolve(docsDir, "compare-1-marked.png") });
  console.log("docs/compare-1-marked.png");

  await page.locator('[data-action="run"]').click();
  await page.locator('[data-surface="run"]').waitFor();

  await page.locator('[data-action="sweep"]').click();
  await page.waitForFunction(
    () => document.querySelector('[data-panel="verdict"]')?.getAttribute("data-state") !== "running",
    { timeout: 300_000 },
  );

  await page.locator('[data-panel="verdict"]').screenshot({ path: resolve(docsDir, "compare-2-verdict.png") });
  console.log("docs/compare-2-verdict.png");

  const headline = await page.locator("[data-headline]").textContent();
  const arms = await page.locator("[data-arm]").count();
  await browser.close();

  console.log(`\narms: ${arms}\nheadline: ${headline}`);
  if (failures.length > 0) {
    console.error(`page errors:\n  ${failures.join("\n  ")}`);
    process.exitCode = 1;
  }
}

await main();
