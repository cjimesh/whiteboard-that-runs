/**
 * Messages between the page and the compute worker.
 *
 * Kept in its own module so the page can import the types without importing the
 * worker's module body, which would run the worker's setup on the main thread.
 */
import type { PointResult, ValidationReport } from "../validation/harness.ts";
import type { Probe, SweepTarget } from "../verdict/sweep.ts";
import type { ComparisonSpec, Study } from "../verdict/study.ts";

export type ComputeRequest =
  | { readonly kind: "validate" }
  /**
   * `target` carries the design and its seed, never a running simulation — a
   * `Simulation` holds closures and cannot cross a worker boundary, and a sweep
   * that depended on how a model had been driven would not be answering "what
   * does this design hold to" in the first place.
   *
   * One request shape for one, two or four sweeps: a design with nothing marked
   * and nothing disputed is a study with a single arm, so the page has one path
   * rather than a plain one and a comparing one that could drift apart.
   */
  | { readonly kind: "study"; readonly target: SweepTarget; readonly comparison: ComparisonSpec };

export type ComputeResponse =
  | { readonly kind: "point"; readonly check: string; readonly point: PointResult; readonly index: number; readonly total: number }
  | { readonly kind: "done"; readonly report: ValidationReport }
  | {
      readonly kind: "probe";
      /** Which arm this probe belongs to, so a four-arm study fills in in place. */
      readonly arm: string;
      readonly probe: Probe;
      readonly index: number;
      readonly maxProbes: number;
    }
  | { readonly kind: "studied"; readonly study: Study }
  | { readonly kind: "error"; readonly message: string };
