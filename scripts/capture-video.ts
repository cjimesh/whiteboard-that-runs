/**
 * Records the README's demo video into `.tooling/video/demo.webm`.
 *
 * Same rules as `capture-demo.ts`: the shipped `dist/index.html` over `file://`,
 * never a development server, and the arc is checked as it is recorded, so a
 * video of a collapse that did not happen cannot be committed by accident.
 *
 * The arc: the demo holding at its resting load; spiky load on the same average,
 * which tips it into a retry storm; retries switched off live, which brings it
 * back with the spikes still arriving; then a typed formula for the load.
 *
 * Playwright writes WebM, kept out of the repo. `scripts/encode-video.sh` turns
 * it into the MP4 and GIF under `docs/` that the README uses.
 */
import "../tooling-env.ts";
import { rename, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium, type Page } from "playwright";

const root = resolve(import.meta.dirname, "..");
const recordDir = resolve(root, ".tooling", "video");
const target = `file://${resolve(root, "dist/index.html")}`;
const size = { width: 1280, height: 800 };

async function rate(page: Page, label: string): Promise<number> {
  const text = await page
    .locator(".wtr-readout", { has: page.locator(".wtr-readout-label", { hasText: label }) })
    .locator(".wtr-readout-value")
    .textContent();
  return Number((text ?? "").replace("/s", ""));
}

async function main(): Promise<void> {
  await rm(recordDir, { recursive: true, force: true });

  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: size, recordVideo: { dir: recordDir, size } });
  const page = await context.newPage();

  const failures: string[] = [];
  page.on("pageerror", (error) => failures.push(String(error)));

  await page.goto(target);
  await page.locator('[data-surface="run"]').waitFor();
  // The tour card is for a first visit; the video narrates itself.
  await page.locator(".wtr-guidance-dismiss").click({ timeout: 2_000 }).catch(() => undefined);
  await page.selectOption('[data-action="speed"]', "4");

  // 1. Steady and healthy.
  await page.waitForTimeout(4_000);
  const steady = await rate(page, "completing");

  // 2. The same load, arriving in spikes.
  await page.selectOption('[data-action="pattern"]', "spiky");
  await page.waitForTimeout(9_000);
  const spiked = await rate(page, "completing");

  // 3. One live change, nothing restarted, spikes still arriving.
  await page.selectOption('[data-action="preset:retry-policy"]', "none");
  await page.waitForTimeout(9_000);
  const recovered = await rate(page, "completing");

  // 4. A load shape typed as a formula.
  await page.selectOption('[data-action="pattern"]', "formula");
  const formula = page.locator('[data-action="pattern:formula"]');
  await formula.fill("");
  await formula.pressSequentially("t % 40 < 20 ? base : base * 1.8", { delay: 45 });
  await formula.press("Enter");
  await formula.blur();
  await page.waitForTimeout(8_000);

  const video = page.video();
  await context.close();
  await browser.close();
  const recorded = await video?.path();
  if (recorded === undefined) throw new Error("no video was recorded");
  await rename(recorded, resolve(recordDir, "demo.webm"));
  console.log(".tooling/video/demo.webm");

  console.log(`steady ${steady}/s, spiky ${spiked}/s, retries off ${recovered}/s`);
  if (failures.length > 0) throw new Error(`page errors during capture:\n  ${failures.join("\n  ")}`);
  if (steady < 15) throw new Error(`the demo was not healthy at rest: ${steady}/s`);
  if (spiked > 5) throw new Error(`spiky load did not collapse the demo: ${spiked}/s`);
  if (recovered < 15) throw new Error(`switching retries off did not recover it: ${recovered}/s`);
}

await main();
