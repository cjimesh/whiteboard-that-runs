/**
 * The editable parameters of one component, as values rather than markup.
 *
 * This lives beside the document rather than in `ui/` because it has no DOM in
 * it and two callers now: the editor renders these fields, and the breaking-point
 * study needs to set the disputed one to each end of its range. A second parser
 * for "what does capacity mean on a datastore" is exactly the kind of duplicate
 * that ends with a panel and a sweep disagreeing about the same number.
 *
 * Driven by `CONCERNS` — the same table the engine uses to decide what a kind
 * reads — so a datastore is never offered a retry policy it would silently
 * ignore. That is the failure the spec format's `strictConcerns` check exists to
 * catch at authoring time; showing the field at all would be the editor
 * manufacturing exactly the mistake the format is trying to prevent.
 *
 * Fields are values, not markup: `fieldsFor` is a pure list that can be asserted
 * without a DOM, and the panel is a thin renderer over it. Every `apply` returns
 * either a new spec or a message, and never a partly-applied one.
 */
import {
  CONCERNS,
  BALANCER_POLICIES,
  HOLD_POLICIES,
  QUEUE_POLICIES,
  DOWNSTREAM_POLICIES,
  RETRY_POLICIES,
  resolveSpec,
  type ComponentKind,
  type PartialComponentSpec,
} from "../specs/format.ts";
import { capacityOf, capacityUnit, describeCapacity, parseCapacity, withCapacity } from "../specs/capacity.ts";
import { describeTimeout, parseTimeout, timeoutOf, withTimeout } from "../specs/timeout.ts";

export type ParamApply = { ok: true; spec: PartialComponentSpec } | { ok: false; error: string };

/**
 * Where a field is asked.
 *
 * `core` — one of the two or three questions every component of this kind is
 * asked up front. `details` — set by the archetype, folded away, there for the
 * author who wants it. `arrow` — about how this component calls the next thing,
 * so it is asked on the arrow it governs rather than on the box. `readout` —
 * derived from the others and shown, never typed, so one fact has one input;
 * kept in this list because a saved dispute may still name it.
 */
export type ParamTier = "core" | "details" | "arrow" | "readout";

export interface ParamField {
  /** Stable handle for tests and `data-param`. */
  key: string;
  /** How the field is asked: a question, in the author's words. */
  label: string;
  /**
   * How the quantity is named inside a sentence — "depending where db-1's
   * connection count really sits". A question cannot be read back mid-sentence.
   */
  noun: string;
  tier: ParamTier | ((spec: PartialComponentSpec) => ParamTier);
  control: "text" | "number" | "select";
  unit?: string;
  options?: Array<{ value: string; label: string }>;
  value: (spec: PartialComponentSpec) => string;
  /** One line under the field: what this setting means here. */
  describe?: (spec: PartialComponentSpec) => string;
  apply: (spec: PartialComponentSpec, raw: string) => ParamApply;
}

function options(values: readonly string[]): Array<{ value: string; label: string }> {
  return values.map((value) => ({ value, label: value.replace(/-/g, " ") }));
}

/** Whole numbers with a floor, the shape most of these parameters share. */
function wholeNumber(
  raw: string,
  least: number,
  noun: string,
): { ok: true; value: number } | { ok: false; error: string } {
  const value = Number(raw.trim());
  if (raw.trim() === "" || !Number.isFinite(value) || !Number.isInteger(value) || value < least) {
    return { ok: false, error: `${noun} must be a whole number of at least ${least}.` };
  }
  return { ok: true, value };
}

export function fieldsFor(kind: ComponentKind): ParamField[] {
  const reads = CONCERNS[kind];
  const fields: ParamField[] = [];

  if (reads.includes("service")) {
    fields.push({
      key: "capacity",
      label: "Capacity",
      noun: "capacity",
      // Derived from how many at once and how long each takes. Typing it as well
      // would be a second input for one fact, and the two would disagree.
      tier: "readout",
      control: "text",
      unit: "/s",
      value: (spec) => {
        const reading = capacityOf(kind, spec);
        return reading !== null && Number.isFinite(reading.perSecond)
          ? String(Number(reading.perSecond.toFixed(2)))
          : "";
      },
      describe: (spec) => {
        const reading = capacityOf(kind, spec);
        return reading === null ? "" : describeCapacity(reading);
      },
      apply: (spec, raw) => {
        const parsed = parseCapacity(raw);
        return parsed.ok ? { ok: true, spec: withCapacity(kind, spec, parsed.perSecond) } : { ok: false, error: parsed.error };
      },
    });
  }

  if (reads.includes("concurrency")) {
    fields.push({
      key: "concurrency",
      label: "How many at once?",
      noun: `${capacityUnit(kind, 1)} count`,
      tier: "core",
      control: "number",
      unit: capacityUnit(kind, 2),
      value: (spec) => String(resolveSpec(kind, spec).concurrency),
      apply: (spec, raw) => {
        const parsed = wholeNumber(raw, 1, "How many at once");
        return parsed.ok ? { ok: true, spec: { ...spec, concurrency: parsed.value } } : { ok: false, error: parsed.error };
      },
    });
  }

  if (reads.includes("service")) {
    fields.push({
      key: "service-time",
      label: "How long does one take?",
      noun: "time per request",
      tier: "core",
      control: "text",
      unit: "ms",
      // The mean. Whether it varies is the archetype's call, under Details; the
      // number people have is "about 10 ms", and that is what is asked.
      value: (spec) => String(Number((resolveSpec(kind, spec).service.mean * 1000).toFixed(3))),
      // The number people have to hand is end-to-end, which already contains the
      // waits the model adds itself; typed in, those waits count twice. The first
      // person to use the editor asked which one this meant.
      describe: () =>
        reads.includes("downstream")
          ? "Its own work on one request, on average. Don't include time waiting on what it calls; the model adds that."
          : "Its own work on one request, on average.",
      apply: (spec, raw) => {
        const match = /^\s*([0-9]*\.?[0-9]+)\s*(ms|s)?\s*$/i.exec(raw);
        const value = match === null ? Number.NaN : Number(match[1]) * (match[2]?.toLowerCase() === "s" ? 1000 : 1);
        if (!Number.isFinite(value) || value < 0) {
          return { ok: false, error: "Enter a time in milliseconds, for example 40." };
        }
        const resolved = resolveSpec(kind, spec);
        return { ok: true, spec: { ...spec, service: { ...resolved.service, mean: value / 1000 } } };
      },
    });
  }

  if (reads.includes("queue")) {
    fields.push({
      key: "queue-policy",
      label: "When it is full",
      noun: "full-queue policy",
      tier: "details",
      control: "select",
      options: [
        { value: "fifo", label: "turn new arrivals away" },
        { value: "drop-oldest", label: "drop the oldest waiting" },
        { value: "priority", label: "serve first tries before retries" },
      ],
      value: (spec) => resolveSpec(kind, spec).queue.policy,
      apply: (spec, raw) => ({
        ok: true,
        spec: { ...spec, queue: { ...resolveSpec(kind, spec).queue, policy: raw as (typeof QUEUE_POLICIES)[number] } },
      }),
    });
    fields.push({
      key: "queue-capacity",
      label: "How many may wait?",
      noun: "queue size",
      tier: "details",
      control: "number",
      value: (spec) => String(resolveSpec(kind, spec).queue.capacity),
      describe: () => "How much work may queue, not counting what is in progress.",
      apply: (spec, raw) => {
        const parsed = wholeNumber(raw, 0, "Queue size");
        return parsed.ok
          ? { ok: true, spec: { ...spec, queue: { ...resolveSpec(kind, spec).queue, capacity: parsed.value } } }
          : { ok: false, error: parsed.error };
      },
    });
  }

  if (reads.includes("hold")) {
    // Two fields, because a lease is two decisions: whether this component lends
    // something out at all, and for how long. Folding them into one number would
    // mean a hold of zero standing for "no hold", and zero is a legitimate thing
    // to want to say about a duration.
    fields.push({
      key: "hold-policy",
      label: "Holds its slot",
      noun: "hold policy",
      tier: "details",
      control: "select",
      options: [
        { value: "none", label: "only while working" },
        { value: "fixed", label: "for a fixed time" },
        { value: "exponential", label: "for a variable time" },
      ],
      value: (spec) => resolveSpec(kind, spec).hold.policy,
      describe: (spec) =>
        resolveSpec(kind, spec).hold.policy === "none"
          ? "The slot comes back as soon as the request moves on."
          : "The slot stays taken after this component has answered — a lease. What bounds throughput is then how long it is lent out, not how long the work takes.",
      apply: (spec, raw) => {
        if (!(HOLD_POLICIES as readonly string[]).includes(raw)) {
          return { ok: false, error: `"${raw}" is not one of: ${HOLD_POLICIES.join(", ")}.` };
        }
        const resolved = resolveSpec(kind, spec);
        return { ok: true, spec: { ...spec, hold: { ...resolved.hold, policy: raw as never } } };
      },
    });

    fields.push({
      key: "hold-mean",
      label: "How long is each one held?",
      // Read back inside sentences the readout builds — "depending where
      // pool-1's hold time really sits".
      noun: "hold time",
      // A core question only where there is a lease: for a session pool it is
      // *the* number, and for everything else it means nothing.
      tier: (spec) => (resolveSpec(kind, spec).hold.policy === "none" ? "details" : "core"),
      control: "text",
      unit: "s",
      value: (spec) => String(Number(resolveSpec(kind, spec).hold.mean.toFixed(3))),
      describe: (spec) => {
        const resolved = resolveSpec(kind, spec);
        if (resolved.hold.policy === "none") return "Not in use while the slot is only held during the work.";
        // The arithmetic printed, because this is the number that decides the
        // answer and nobody should have to do the division themselves.
        const perSecond = resolved.concurrency / resolved.hold.mean;
        return `${resolved.concurrency} × 1/${Number(resolved.hold.mean.toFixed(3))}s ⇒ ${
          perSecond >= 10 ? Math.round(perSecond) : Number(perSecond.toFixed(2))
        }/s sustained, whatever the work takes.`;
      },
      apply: (spec, raw) => {
        const value = Number(raw.trim());
        if (raw.trim() === "" || !Number.isFinite(value) || value <= 0) {
          return { ok: false, error: "A hold has to be a positive number of seconds." };
        }
        const resolved = resolveSpec(kind, spec);
        return { ok: true, spec: { ...spec, hold: { ...resolved.hold, mean: value } } };
      },
    });
  }

  if (reads.includes("timeout")) {
    fields.push({
      key: "timeout",
      label: "Timeout",
      noun: "timeout",
      tier: "arrow",
      control: "text",
      unit: "ms",
      value: (spec) => {
        const reading = timeoutOf(kind, spec);
        if (reading === null) return "";
        return reading.policy === "none" ? "off" : String(Number(reading.milliseconds.toFixed(2)));
      },
      describe: (spec) => {
        const reading = timeoutOf(kind, spec);
        return reading === null ? "" : describeTimeout(reading);
      },
      apply: (spec, raw) => {
        const parsed = parseTimeout(raw);
        return parsed.ok ? { ok: true, spec: withTimeout(kind, spec, parsed.milliseconds) } : { ok: false, error: parsed.error };
      },
    });
  }

  if (reads.includes("retry")) {
    fields.push({
      key: "retry-policy",
      label: "On a failed call",
      noun: "retry policy",
      tier: "arrow",
      control: "select",
      options: options(RETRY_POLICIES),
      value: (spec) => resolveSpec(kind, spec).retry.policy,
      describe: () => "Retries are new load on whatever failed. This is the setting that turns a slow dependency into a storm.",
      apply: (spec, raw) => ({
        ok: true,
        spec: { ...spec, retry: { ...resolveSpec(kind, spec).retry, policy: raw as (typeof RETRY_POLICIES)[number] } },
      }),
    });
    fields.push({
      key: "retry-attempts",
      label: "Extra attempts",
      noun: "retry count",
      tier: "arrow",
      control: "number",
      value: (spec) => String(resolveSpec(kind, spec).retry.attempts),
      describe: () => "Beyond the first try. Each one multiplies the work a failure costs downstream.",
      apply: (spec, raw) => {
        const parsed = wholeNumber(raw, 0, "Attempts");
        return parsed.ok
          ? { ok: true, spec: { ...spec, retry: { ...resolveSpec(kind, spec).retry, attempts: parsed.value } } }
          : { ok: false, error: parsed.error };
      },
    });
  }

  if (reads.includes("downstream")) {
    fields.push({
      key: "downstream",
      label: "While the next one answers",
      noun: "waiting policy",
      tier: "arrow",
      control: "select",
      options: [
        { value: "call-and-wait", label: "wait (holds a server)" },
        { value: "fire-and-forget", label: "carry on (releases it)" },
      ],
      value: (spec) => resolveSpec(kind, spec).downstream.policy,
      describe: () => "Waiting is what makes a slow dependency saturate its caller. Choose it deliberately.",
      apply: (spec, raw) => ({
        ok: true,
        spec: { ...spec, downstream: { policy: raw as (typeof DOWNSTREAM_POLICIES)[number] } },
      }),
    });
  }

  if (reads.includes("balancer")) {
    fields.push({
      key: "balancer",
      label: "How does it choose?",
      noun: "routing",
      tier: "core",
      control: "select",
      options: [
        { value: "round-robin", label: "in turn" },
        { value: "least-queue", label: "whichever has the shortest queue" },
        { value: "random", label: "at random" },
      ],
      value: (spec) => resolveSpec(kind, spec).balancer.policy,
      apply: (spec, raw) => ({
        ok: true,
        spec: { ...spec, balancer: { policy: raw as (typeof BALANCER_POLICIES)[number] } },
      }),
    });
  }

  if (reads.includes("cache")) {
    fields.push({
      key: "hit-ratio",
      label: "How often is the answer already here?",
      noun: "hit ratio",
      tier: "core",
      control: "text",
      unit: "%",
      value: (spec) => String(Number((resolveSpec(kind, spec).cache.hitRatio * 100).toFixed(2))),
      // The one number on this panel that is not a measurement of anything, and
      // the legend says so too. An author states it; the model never checks it.
      describe: () => "The share answered here without reaching what is behind it. An input, never a measurement.",
      apply: (spec, raw) => {
        const value = Number(raw.trim().replace(/%$/, ""));
        if (raw.trim() === "" || !Number.isFinite(value) || value < 0 || value > 100) {
          return { ok: false, error: "Enter a percentage between 0 and 100." };
        }
        return { ok: true, spec: { ...spec, cache: { ...resolveSpec(kind, spec).cache, hitRatio: value / 100 } } };
      },
    });
  }

  return fields;
}

/** Where a field is asked, for this spec. */
export function tierOf(field: ParamField, spec: PartialComponentSpec): ParamTier {
  return typeof field.tier === "function" ? field.tier(spec) : field.tier;
}
