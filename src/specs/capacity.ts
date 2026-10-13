/**
 * Capacity, in the units a reviewer actually speaks.
 *
 * Nobody in a design review says "the service time mean is twenty milliseconds".
 * They say "the database does about fifty a second". Both are the same statement,
 * and this file is the conversion between them:
 *
 *     capacity (per second)  =  concurrency / service.mean
 *     service.mean           =  concurrency / capacity
 *
 * So this is a *unit change on an existing input*, not a new one. The spec stays
 * canonical, the engine is untouched, and no component gains a number it did not
 * already have.
 *
 * ❗ The distinction this file must never blur: capacity is what a component
 * *can* serve, and throughput is what it *did* serve. They are different numbers
 * and the gap between them is the entire product. A knob that set throughput
 * directly would make the tool a spreadsheet — it would report back whatever was
 * typed, and the retry death spiral could never emerge, because the spiral is
 * demand rising against a fixed capability. So capacity is an input and appears
 * in the parameter panel; throughput is measured and appears only on a gauge.
 * The two are never given the same label.
 *
 * Two honest caveats that belong next to the knob:
 *
 * - Under `exponential` service, capacity is a *mean* rate (μ). Individual
 *   requests take longer and shorter, and that variance is what produces the
 *   queueing the validation suite checks against M/M/1.
 * - Measured throughput sits *below* capacity whenever anything is queueing, and
 *   equals it only at saturation — which is the moment latency runs away. A
 *   component reading 48/s against a 50/s capacity is not "nearly fine".
 */
import {
  CONCERNS,
  resolveSpec,
  type ComponentKind,
  type PartialComponentSpec,
  type ServiceTimePolicy,
} from "./format.ts";

export interface CapacityReading {
  kind: ComponentKind;
  /** Sustained requests per second across all servers. `Infinity` if service is instant. */
  perSecond: number;
  concurrency: number;
  /** Seconds a server is occupied per request. The hold, when there is one. */
  meanSeconds: number;
  policy: ServiceTimePolicy;
  /**
   * True when the occupancy is a lease rather than the service time.
   *
   * The distinction has to survive into the reading, because the two produce the
   * same rate from completely different sentences: "fifty a second" is 1,000
   * sessions held for 20 seconds or one connection working for 20 milliseconds,
   * and a knob that could not tell them apart would silently edit the wrong one.
   */
  leased: boolean;
}

/** Whether a kind does work that takes time, and so has a capacity to state. */
export function hasCapacity(kind: ComponentKind): boolean {
  return CONCERNS[kind].includes("service");
}

/**
 * What a kind calls the things that serve in parallel.
 *
 * A datastore's concurrency is its connection pool and a queue's is its consumer
 * count; calling both "servers" would make the knob read like a generic form
 * rather than a statement about this component.
 */
const CONCURRENCY_NOUN: Record<ComponentKind, string> = {
  service: "server",
  queue: "consumer",
  balancer: "route",
  cache: "server",
  datastore: "connection",
};

export function capacityUnit(kind: ComponentKind, count: number): string {
  const noun = CONCURRENCY_NOUN[kind];
  return count === 1 ? noun : `${noun}s`;
}

/**
 * Read the capacity a spec implies. `null` for kinds with no service time.
 *
 * Partial specs are resolved against the same per-kind defaults the engine uses,
 * so a component dropped on the canvas states a capacity before anyone has
 * touched a parameter — and it states the one it will actually run at.
 */
export function capacityOf(kind: ComponentKind, spec: PartialComponentSpec): CapacityReading | null {
  if (!hasCapacity(kind)) return null;

  const resolved = resolveSpec(kind, spec);
  const { concurrency } = resolved;

  // What bounds throughput is how long a *slot* is taken, which is the hold when
  // there is one and the service time otherwise. Reading capacity off the service
  // time of a leased component was the exact error this concern exists to fix: it
  // reported a session pool as good for hundreds a second when it was good for
  // about ten.
  const leased = resolved.hold.policy !== "none" && resolved.hold.mean > 0;
  const meanSeconds = leased ? resolved.hold.mean : resolved.service.mean;

  return {
    kind,
    leased,
    // Instant service is unbounded rather than a division by zero. It is a legal
    // thing to author (a cache hit that costs nothing worth modelling), and the
    // knob reports it as unbounded rather than as a very large number that would
    // invite someone to argue with its last digit.
    perSecond: meanSeconds === 0 ? Number.POSITIVE_INFINITY : concurrency / meanSeconds,
    concurrency,
    meanSeconds,
    policy: resolved.service.policy,
  };
}

/**
 * Set a capacity, leaving every other decision alone.
 *
 * One mean moves, and it is the one that bounds throughput: the hold on a leased
 * component, the service time on every other. Writing to the service time of a
 * leased pool would leave the panel reading 10/s while the model ran at 400 —
 * which is precisely the confusion the hold concern was added to end.
 *
 * The policy is deliberately preserved: `fixed` and `exponential` at the same
 * mean are different models of the same rate, and silently turning a variable
 * service time into a metronome would change the queueing the room is looking at
 * without anybody asking for it.
 *
 * Throws on an unusable rate rather than clamping. A knob that quietly snapped
 * to a bound would leave the panel showing one number and the model running
 * another — see `parseCapacity` for the path that turns typed text into a
 * message a person can act on.
 */
export function withCapacity(
  kind: ComponentKind,
  spec: PartialComponentSpec,
  perSecond: number,
): PartialComponentSpec {
  if (!hasCapacity(kind)) {
    throw new Error(`a ${kind} has no service time, so it has no capacity to set`);
  }
  if (!Number.isFinite(perSecond) || perSecond <= 0) {
    throw new Error(`capacity must be a positive, finite number of requests per second, got ${perSecond}`);
  }

  const resolved = resolveSpec(kind, spec);
  const mean = resolved.concurrency / perSecond;

  if (resolved.hold.policy !== "none" && resolved.hold.mean > 0) {
    return { ...spec, hold: { policy: resolved.hold.policy, mean } };
  }
  return { ...spec, service: { policy: resolved.service.policy, mean } };
}

/** Rate as a person would say it: whole numbers stay whole, fractions keep one place. */
function formatRate(perSecond: number): string {
  if (perSecond >= 100) return String(Math.round(perSecond));
  if (Number.isInteger(perSecond)) return String(perSecond);
  return perSecond.toFixed(perSecond >= 10 ? 1 : 2).replace(/\.?0+$/, "");
}

/** Duration at a scale that reads, rather than `0.0002 s`. */
function formatSeconds(seconds: number): string {
  if (seconds >= 1) return `${Number(seconds.toFixed(2))} s`;
  if (seconds >= 0.001) return `${Number((seconds * 1000).toFixed(2))} ms`;
  return `${Number((seconds * 1_000_000).toFixed(0))} µs`;
}

/**
 * The conversion, printed.
 *
 * Shown under the knob so the derived quantity is never hidden: someone who
 * types 50/s can see that it became 20 ms of work on one connection, and can
 * argue with either end of it. A knob whose arithmetic is invisible is a knob
 * the room has to take on trust, which is the opposite of what this tool is for.
 */
export function describeCapacity(reading: CapacityReading): string {
  const servers = `${reading.concurrency} ${capacityUnit(reading.kind, reading.concurrency)}`;
  if (!Number.isFinite(reading.perSecond)) return `unbounded ⇒ instant, × ${servers}`;
  // "held for" rather than "×" on a lease: the sentence has to say that the rate
  // comes from how long the thing is lent out, not from how long the work takes.
  const occupancy = reading.leased
    ? `held for ${formatSeconds(reading.meanSeconds)}`
    : formatSeconds(reading.meanSeconds);
  return `${formatRate(reading.perSecond)}/s ⇒ ${occupancy} × ${servers}`;
}

export type CapacityInput = { ok: true; perSecond: number } | { ok: false; error: string };

/**
 * Read a typed rate. Accepts the unit people type along with the number.
 *
 * Returns a message rather than throwing, because this is the one entry point
 * fed directly by a keyboard, and "50/s" or "1500 rps" are what someone writes
 * when the field is labelled in requests per second.
 */
export function parseCapacity(text: string): CapacityInput {
  const trimmed = text.trim();
  if (trimmed === "") return { ok: false, error: "Enter a rate, for example 50/s." };

  const match = /^([0-9]*\.?[0-9]+)\s*(?:\/\s*s|\/\s*sec|rps|qps|per second)?$/i.exec(trimmed);
  if (match === null) {
    return { ok: false, error: `"${trimmed}" is not a rate. Enter requests per second, for example 50/s.` };
  }

  const perSecond = Number(match[1]);
  if (!Number.isFinite(perSecond) || perSecond <= 0) {
    return { ok: false, error: "A capacity has to be greater than zero." };
  }
  return { ok: true, perSecond };
}
