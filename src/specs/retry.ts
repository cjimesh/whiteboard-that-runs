/**
 * What a retry policy means, in one place.
 *
 * Two different calls retry: a service's call to its successor, and any
 * component's call to a dependency. They read the same `RetrySpec`, and if each
 * did its own arithmetic the two would eventually disagree about what "three
 * retries, doubling the wait" means — the kind of drift that only shows up as a
 * number nobody can explain.
 */
import type { RetrySpec } from "./format.ts";

/** Seconds to wait before attempt number `attempt` (1 = first retry). */
export function backoff(retry: RetrySpec, attempt: number): number {
  const { policy, delay, factor, maxDelay } = retry;
  switch (policy) {
    case "none":
      return 0;
    case "fixed":
      return delay;
    case "exponential":
      return delay * Math.pow(factor, attempt - 1);
    case "capped":
      return Math.min(maxDelay, delay * Math.pow(factor, attempt - 1));
  }
}

/** Every try a request may make, the first included. */
export function maxAttempts(retry: RetrySpec): number {
  return retry.policy === "none" ? 1 : 1 + retry.attempts;
}

/**
 * Set how many more times a failed call is asked. `null` or 0 switches retrying
 * off.
 *
 * Turning it on from off picks `fixed` backoff and keeps whatever delay the spec
 * already carries; changing the count on an existing policy keeps its backoff
 * shape. The count is the number that decides how much extra load a failure
 * becomes, so it is the one an author types; the backoff is said in the sentence
 * under it rather than asked.
 */
export function withRetryCount(retry: RetrySpec, attempts: number | null): RetrySpec {
  if (attempts === null || attempts === 0) return { ...retry, policy: "none" };
  if (!Number.isInteger(attempts) || attempts < 0) {
    throw new Error(`retries must be a whole number of at least 0, got ${attempts}`);
  }
  return { ...retry, policy: retry.policy === "none" ? "fixed" : retry.policy, attempts };
}
