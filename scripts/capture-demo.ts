/**
 * Captures the demo arc into `docs/`.
 *
 * These frames are the eyeball check the plan asks for, and the thing a reviewer
 * can look at without running anything: is the folding component unmistakable
 * *without reading a number*? That question cannot be settled by a test, so the
 * frames are committed and the claim is checkable.
 *
 * Every capture is taken against the shipped `dist/index.html` over `file://`,
 * which is how a recipient opens it — so what is photographed is the artifact,
 * not a development server.
 *
 * Never captured at sim time zero: an empty model photographs as a blank canvas
 * and teaches a reader nothing.
 */
import "../tooling-env.ts";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright";

const root = resolve(import.meta.dirname, "..");
const docsDir = resolve(root, "docs");
const target = `file://${resolve(root, "dist/index.html")}`;

/** Sim seconds per wall second, so a 60-second arc captures in fifteen. */
const SPEED = "4";

async function main(): Promise<void> {
  await mkdir(docsDir, { recursive: true });

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

  const failures: string[] = [];
  page.on("pageerror", (error) => failures.push(String(error)));

  await page.goto(target);
  await page.locator('[data-surface="run"]').waitFor();
  await page.selectOption('[data-action="speed"]', SPEED);

  const shot = async (name: string): Promise<void> => {
    await page.screenshot({ path: resolve(docsDir, name) });
    console.log(`docs/${name}`);
  };

  const rate = async (label: string): Promise<number> => {
    const text = await page
      .locator(".wtr-readout", { has: page.locator(".wtr-readout-label", { hasText: label }) })
      .locator(".wtr-readout-value")
      .textContent();
    return Number((text ?? "").replace("/s", ""));
  };

  // 1. Boring and green: the state the arc has to start from, or the collapse is
  //    just a broken-looking tool rather than a change anyone noticed.
  await page.waitForTimeout(5_000);
  await shot("demo-1-holding.png");

  // 2. Dragged to a rate the database would manage on its own.
  await page.locator('[data-action="load"]').evaluate((el: HTMLInputElement) => {
    el.value = "44";
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await page.waitForTimeout(10_000);
  await shot("demo-2-retry-storm.png");
  const collapsed = await rate("completing");

  // 3. One live change, no restart.
  await page.selectOption('[data-action="preset:database-queue"]', "shed");
  await page.waitForTimeout(5_000);
  await shot("demo-3-recovered.png");
  const recovered = await rate("completing");

  // 4. The credibility artifact, mid-run.
  await page.locator('[data-action="validation"]').click();
  // Until it finishes, not for a fixed time: the table grew to twelve points with
  // the lease checks, and a fixed wait that once fit stopped fitting silently.
  await page.waitForFunction(
    () => document.querySelector(".wtr-validation-status")?.getAttribute("data-state") !== "running",
    undefined,
    { timeout: 150_000 },
  );
  await shot("demo-4-validation.png");
  const verdict = await page.locator(".wtr-validation-status").getAttribute("data-state");

  await browser.close();

  console.log(`collapsed to ${collapsed}/s, recovered to ${recovered}/s, validation: ${verdict}`);
  if (failures.length > 0) throw new Error(`page errors during capture:\n  ${failures.join("\n  ")}`);
  if (collapsed !== 0) throw new Error(`the arc did not collapse: goodput was ${collapsed}/s`);
  if (recovered < 20) throw new Error(`the arc did not recover: goodput was ${recovered}/s`);
  if (verdict !== "pass") throw new Error(`validation did not pass: ${verdict}`);
}

await main();
