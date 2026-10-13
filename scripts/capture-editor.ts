/**
 * A frame of the editor, for the docs.
 *
 * Same discipline as `capture-demo.ts`: the picture in the docs is taken from
 * the shipped file, opened off the filesystem, so it cannot drift from what
 * somebody sent the file actually sees.
 */
import "../tooling-env.ts";
import { resolve } from "node:path";
import { chromium } from "playwright";

const distDir = resolve(process.cwd(), "dist");
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

await page.goto(`file://${distDir}/index.html`);
await page.locator('[data-surface="run"]').waitFor();
await page.locator('[data-action="edit"]').click();
await page.locator('[data-surface="editor"]').waitFor();
await page.locator('[data-action="add:cache"]').click();

await page.screenshot({ path: "docs/editor-1-refused.png" });
console.log("docs/editor-1-refused.png");

await browser.close();
