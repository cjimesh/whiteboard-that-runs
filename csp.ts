/**
 * The pinned Content-Security-Policy for the production build.
 *
 * This is the structural half of the zero-egress promise (R11): the page
 * declares no network destinations at all, so a model of somebody's production
 * architecture has nowhere to go. It ships as a `<meta>` tag rather than a
 * response header so the artifact stays host-agnostic (one static file, any
 * static host, or no host at all off `file://`), which carries two known limits
 * worth stating plainly:
 *
 *   1. A meta CSP only governs what loads *after* it, so the tag must be the
 *      first element in `<head>`. `assertPinnedCsp` enforces that.
 *   2. `frame-ancestors` and `sandbox` are header-only directives and are
 *      silently ignored in meta form, so they are deliberately absent here.
 *
 * `'unsafe-inline'` is required by the single-file build, where all script and
 * style is inlined into the one HTML file. Every byte of that bundle is
 * first-party by construction, and no directive permits a network destination.
 *
 * `worker-src blob:` is the one addition over the prior-art policy. The sweep
 * runs headless simulation off the main thread (U7), bundled via Vite's
 * `?worker&inline` so its code is inlined into the same file and instantiated
 * from a blob URL. A blob URL is same-origin data the page already holds; it
 * opens no network destination, so the zero-egress claim is unchanged. It is
 * pinned here from day one rather than added at U7, because the policy string
 * is the thing under test and it should not drift mid-build.
 *
 * Applied to production builds only — a zero-destination policy would break
 * Vite's HMR websocket and leave the dev loop broken.
 */
export const PINNED_CSP =
  "default-src 'none'; " +
  "script-src 'self' 'unsafe-inline'; " +
  "style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data:; " +
  "worker-src blob:; " +
  "connect-src 'none'; " +
  "form-action 'none'; " +
  "base-uri 'none'; " +
  "object-src 'none'";

export const CSP_META_TAG = `<meta http-equiv="Content-Security-Policy" content="${PINNED_CSP}">`;

/** Directives that a meta-delivered CSP cannot express, documented so the gap is deliberate. */
export const HEADER_ONLY_DIRECTIVES = ["frame-ancestors", "sandbox"] as const;

export interface CspAssertion {
  ok: boolean;
  failures: string[];
}

/**
 * Assert that built HTML carries the pinned policy as the first element in `<head>`.
 *
 * Used by the build-time test so the zero-egress claim is verified mechanically
 * rather than spot-checked by eye.
 */
export function assertPinnedCsp(html: string): CspAssertion {
  const failures: string[] = [];

  const headMatch = /<head[^>]*>([\s\S]*?)<\/head>/i.exec(html);
  const headInner = headMatch?.[1];
  if (headInner === undefined) {
    return { ok: false, failures: ["no <head> element found in the built HTML"] };
  }

  const firstElement = /<[a-zA-Z][^>]*>/.exec(headInner);
  if (!firstElement) {
    return { ok: false, failures: ["<head> contains no elements"] };
  }

  // The policy text itself contains single quotes (`'none'`), so the content
  // attribute must be matched by its own delimiter rather than a shared class.
  const cspMeta =
    /<meta\s+http-equiv=["']Content-Security-Policy["']\s+content=(?:"([^"]*)"|'([^']*)')\s*\/?>/i.exec(
      headInner,
    );

  if (!cspMeta) {
    failures.push("no Content-Security-Policy <meta> tag found in <head>");
    return { ok: false, failures };
  }

  if (cspMeta.index !== firstElement.index) {
    failures.push(
      "the CSP <meta> tag is not the first element in <head>; " +
        "anything loaded before it is ungoverned",
    );
  }

  const content = cspMeta[1] ?? cspMeta[2];
  if (content !== PINNED_CSP) {
    failures.push(
      `CSP content drifted from the pinned policy.\n  expected: ${PINNED_CSP}\n  actual:   ${content}`,
    );
  }

  return { ok: failures.length === 0, failures };
}
