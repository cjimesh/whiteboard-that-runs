/**
 * Points Playwright at a project-local browser install when one is present.
 *
 * On a normal machine `npx playwright install --with-deps` puts the browser in
 * the shared cache and this module does nothing. It exists for environments
 * without root, where the browser and its shared libraries are unpacked under
 * `.tooling/` (gitignored) instead of into system locations.
 *
 * Playwright reads these variables when it is first imported, so anything that
 * launches a browser must import this module *before* importing playwright.
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const toolingDir = resolve(import.meta.dirname, ".tooling");

if (existsSync(toolingDir)) {
  process.env["PLAYWRIGHT_BROWSERS_PATH"] ??= resolve(toolingDir, "playwright-browsers");

  const libs = resolve(toolingDir, "chromium-libs/usr/lib/x86_64-linux-gnu");
  if (existsSync(libs) && !(process.env["LD_LIBRARY_PATH"] ?? "").includes(libs)) {
    process.env["LD_LIBRARY_PATH"] = `${libs}:${process.env["LD_LIBRARY_PATH"] ?? ""}`;
  }
}
