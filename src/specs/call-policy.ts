/**
 * How a component treats one call to a dependency: when it gives up, and whether
 * it asks again.
 *
 * It lives on the call edge, beside `times`, because that is where it lives in a
 * real system. "Every Redis read is retried once on timeout" is a property of the
 * Redis client, not of the component holding it, and one component routinely
 * leans on things it treats differently — an app server calling both a cache and
 * a database does not give them one timeout, and a cache's timeout on the
 * database call would be a setting nobody has.
 *
 * Deliberately the same two concerns, in the same shape, as a service's call to
 * its successor. A second vocabulary for "timeout" and "retry" would be a second
 * thing to learn and a second place for their meaning to drift.
 *
 * Absent means neither: wait as long as the answer takes, and fail the request
 * if the dependency refuses. That is exactly what every dependency call did
 * before this existed, so every saved model runs unchanged.
 */
import { withRetryCount } from "./retry.ts";
import { resolveSpec, validateSpec, type RetrySpec, type SpecValidation, type TimeoutSpec } from "./format.ts";

export interface CallPolicy {
  timeout: TimeoutSpec;
  retry: RetrySpec;
}

export type PartialCallPolicy = Partial<CallPolicy>;

const CALL_CONCERNS = ["timeout", "retry"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Fill a partially-authored policy. Both concerns are present on the result. */
export function resolveCallPolicy(partial: PartialCallPolicy = {}): CallPolicy {
  // Resolved as a service's, because a service is the kind that already reads
  // both concerns, so the defaults are the ones its successor call starts from.
  const { timeout, retry } = resolveSpec("service", partial);
  return { timeout, retry };
}

/**
 * Check a call policy.
 *
 * The concerns themselves are checked by the same code that checks them on a
 * component, so an out-of-range retry count reads the same wherever it is typed.
 */
export function validateCallPolicy(raw: unknown): SpecValidation {
  if (!isRecord(raw)) {
    return { ok: false, errors: [`a call policy must be an object, got ${JSON.stringify(raw)}`] };
  }
  const errors: string[] = [];
  for (const key of Object.keys(raw)) {
    if (!(CALL_CONCERNS as readonly string[]).includes(key)) {
      errors.push(
        `a dependency call does not use "${key}", so setting it would have no effect. ` +
          `It reads: ${CALL_CONCERNS.join(", ")}`,
      );
    }
  }
  const picked: Record<string, unknown> = {};
  for (const key of CALL_CONCERNS) {
    if (raw[key] !== undefined) picked[key] = raw[key];
  }
  errors.push(...validateSpec("service", picked).errors);
  return { ok: errors.length === 0, errors };
}

/** Resolve, but refuse a policy that does not validate — see `resolveSpecStrict`. */
export function resolveCallPolicyStrict(raw: unknown, label: string): CallPolicy {
  const validation = validateCallPolicy(raw);
  if (!validation.ok) {
    throw new Error(`${label} has an invalid call policy:\n  ${validation.errors.join("\n  ")}`);
  }
  return resolveCallPolicy(raw as PartialCallPolicy);
}

// --------------------------------------------------------------- editing
//
// The same arithmetic `timeout.ts` does for a component, for a call. Timeout is
// typed in milliseconds and parsed by the same parser, so "250", "0.25 s" and
// "off" mean one thing everywhere they are typed.

/** Set the call's timeout. `null` switches it off and keeps the duration. */
export function withCallTimeout(policy: PartialCallPolicy, milliseconds: number | null): PartialCallPolicy {
  const current = resolveCallPolicy(policy).timeout;
  if (milliseconds === null) return { ...policy, timeout: { policy: "none", after: current.after } };
  if (!Number.isFinite(milliseconds) || milliseconds <= 0) {
    throw new Error(`a timeout must be a positive, finite number of milliseconds, got ${milliseconds}`);
  }
  return { ...policy, timeout: { policy: "fixed", after: milliseconds / 1000 } };
}

/** Set how many more times the call is asked after it fails — see `withRetryCount`. */
export function withCallRetries(policy: PartialCallPolicy, attempts: number | null): PartialCallPolicy {
  return { ...policy, retry: withRetryCount(resolveCallPolicy(policy).retry, attempts) };
}

export type RetriesInput = { ok: true; attempts: number | null } | { ok: false; error: string };

export function parseRetries(text: string): RetriesInput {
  const trimmed = text.trim();
  if (/^(off|none|never|0)$/i.test(trimmed)) return { ok: true, attempts: null };
  if (/^[0-9]+$/.test(trimmed)) return { ok: true, attempts: Number(trimmed) };
  return { ok: false, error: `"${trimmed}" is not a number of retries. Enter a whole number, for example 1, or 'off'.` };
}

function formatSeconds(seconds: number): string {
  const ms = seconds * 1000;
  return ms >= 1000 ? `${Number(seconds.toFixed(2))} s` : `${Number(ms.toFixed(2))} ms`;
}

/** What the call does, in a sentence — the behaviour, not the settings. */
export function describeCallPolicy(partial: PartialCallPolicy): string {
  const { timeout, retry } = resolveCallPolicy(partial);
  const waits =
    timeout.policy === "none" ? "Waits as long as the answer takes" : `Gives up after ${formatSeconds(timeout.after)}`;
  if (retry.policy === "none" || retry.attempts === 0) return `${waits}; does not ask again.`;

  const times = retry.attempts === 1 ? "once more" : `up to ${retry.attempts} more times`;
  const first = formatSeconds(retry.delay);
  const spacing =
    retry.policy === "fixed"
      ? retry.delay === 0
        ? "straight away"
        : `${first} apart`
      : retry.policy === "exponential"
        ? `waiting ${first}, then ×${retry.factor} each time`
        : `waiting ${first}, then ×${retry.factor} each time up to ${formatSeconds(retry.maxDelay)}`;
  // Said because it is the part people forget: the attempt it gave up on is
  // still at the dependency, being worked on for nobody.
  const abandoned = timeout.policy === "none" ? "" : " The attempt it gave up on is still being worked on.";
  return `${waits}; asks ${times}, ${spacing}.${abandoned}`;
}
