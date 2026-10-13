/**
 * Captures the breaking-point panel into `docs/`.
 *
 * The sweep's whole claim is that its answer arrives with its evidence attached —
 * the rates that were tried, what each one did, and what the answer is relative
 * to. Whether that reads as evidence or as a wall of numbers is a question only
 * an eye can settle, so the frame is committed and the claim is checkable.
 *
 * Captured against the shipped `dist/index.html` over `file://`, like every other
 * frame here: what is photographed is the artifact somebody is sent, not a dev
 * server, and the sweep is running in the inlined worker as it would for them.
 */
import "../tooling-env.ts";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright";

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

  await page.locator('[data-action="sweep"]').click();

  // Mid-search: probes appearing one at a time is the reason the panel is not a
  // spinner, so it is worth a frame of its own.
  await page.waitForFunction(() => document.querySelectorAll(".wtr-verdict-table tbody tr").length >= 2, {
    timeout: 60_000,
  });
  await page.locator('[data-panel="verdict"]').screenshot({ path: resolve(docsDir, "verdict-1-searching.png") });
  console.log("docs/verdict-1-searching.png");

  await page.waitForFunction(
    () => document.querySelector('[data-panel="verdict"]')?.getAttribute("data-state") !== "running",
    { timeout: 180_000 },
  );

  const state = await page.locator('[data-panel="verdict"]').getAttribute("data-state");
  const headline = await page.locator("[data-headline]").textContent();
  const probes = await page.locator(".wtr-verdict-table tbody tr").count();

  await page.locator('[data-panel="verdict"]').screenshot({ path: resolve(docsDir, "verdict-2-answer.png") });
  console.log("docs/verdict-2-answer.png");

  // And the stale mark: an answer that stops describing the model on screen has
  // to say so, and the frame is how that gets checked without reading the code.
  await page.locator('[data-action="load"]').evaluate((el: HTMLInputElement) => {
    el.value = "40";
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await page.locator('[data-panel="verdict"]').screenshot({ path: resolve(docsDir, "verdict-3-stale.png") });
  console.log("docs/verdict-3-stale.png");

  await browser.close();

  console.log(`\nstate: ${state}\nheadline: ${headline}\nprobe rows: ${probes}`);
  if (failures.length > 0) {
    console.error(`page errors:\n  ${failures.join("\n  ")}`);
    process.exitCode = 1;
  }
}

await main();
