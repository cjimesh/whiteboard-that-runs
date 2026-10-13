/**
 * Bundles the view entry into a single browser-loadable script.
 *
 * Cached per process: the bundle is identical for every model, and rebuilding it
 * per test would dominate the runtime.
 */
import { build } from "vite";
import { resolve } from "node:path";

let cached: Promise<string> | null = null;

export function viewBundle(): Promise<string> {
  cached ??= (async () => {
    const result = await build({
      root: process.cwd(),
      logLevel: "error",
      configFile: false,
      build: {
        write: false,
        lib: {
          entry: resolve(process.cwd(), "test/support/view-entry.ts"),
          name: "WTR",
          formats: ["iife"],
          fileName: () => "view.js",
        },
      },
    });

    const output = Array.isArray(result) ? result[0]?.output : undefined;
    const chunk = output?.find((c) => c.type === "chunk");
    if (chunk === undefined || chunk.type !== "chunk") throw new Error("view bundle produced no chunk");
    return chunk.code;
  })();

  return cached;
}

/** A page that paints one model and records the outcome for the test to read. */
export function viewPage(bundle: string, timelineJson: string, seconds: number): string {
  return `<!doctype html>
<html><head><meta charset="utf-8"><style>
  html,body{margin:0;background:#0b0e14}
  canvas{display:block;width:1280px;height:720px}
</style></head><body>
<canvas id="stage"></canvas>
<script>${bundle}</script>
<script>
  window.__result = WTR.renderModel(
    document.getElementById("stage"),
    ${JSON.stringify(timelineJson)},
    ${seconds}
  );
</script>
</body></html>`;
}
