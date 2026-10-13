import "./tooling-env.ts";
import type { Plugin } from "vite";
import { defineConfig } from "vitest/config";
import { viteSingleFile } from "vite-plugin-singlefile";
import { CSP_META_TAG } from "./csp.ts";

/**
 * Injects the pinned CSP as the first element in `<head>`, production builds only.
 *
 * Dev is deliberately left unrestricted: a policy with no network destinations
 * blocks Vite's HMR websocket and its injected client script, which would trade
 * a shipped guarantee for a broken dev loop. The guarantee is a property of the
 * artifact users receive, and that artifact is the build output.
 */
function pinnedCsp(): Plugin {
  return {
    name: "whiteboard-that-runs:pinned-csp",
    apply: "build",
    transformIndexHtml: {
      // `post` so the tag lands after other plugins have finished rewriting
      // <head>, keeping it genuinely first rather than first-at-injection-time.
      order: "post",
      handler(html) {
        return html.replace(/<head([^>]*)>/i, `<head$1>\n    ${CSP_META_TAG}`);
      },
    },
  };
}

export default defineConfig({
  plugins: [viteSingleFile(), pinnedCsp()],
  build: {
    // The offline single file (R11) must run from file:// with no sibling assets.
    // vite-plugin-singlefile disables code splitting itself; these two keep
    // every asset (images, fonts) inside the one file as well.
    assetsInlineLimit: Infinity,
    cssCodeSplit: false,
  },
  worker: {
    /**
     * Classic worker, not a module worker, and this is load-bearing.
     *
     * The compute worker is inlined into the single HTML file and started from a
     * `blob:` URL. A page opened straight off disk has an opaque origin, and a
     * *module* worker from a blob URL is refused there — measured, not assumed:
     * with `format: "es"` the worker constructs and immediately dies over
     * `file://` while working perfectly over `http://`. A classic worker from
     * the same blob URL is fine on both.
     *
     * That matters because double-clicking the file is a distribution channel
     * for this product, not a fallback. Under `es` the validation panel and the
     * breaking-point sweep would have worked for anyone given a link and failed
     * for anyone sent the file — the worse half of that being that it fails
     * quietly, and only for the recipient.
     */
    format: "iife",
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
  },
});
