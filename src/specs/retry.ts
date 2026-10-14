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

/**
 * A retry budget: retries may be at most `budget` of the requests a caller makes.
 *
 * The fix people reach for first when they see a retry storm, and the one the
 * tool could not express: a cap on attempts limits what one failure costs, not
 * what a thousand failures at once cost, so three retries each still quadruple
 * the load on a dependency that is already behind. A budget caps the total.
 *
 * Spent as a token bucket, the shape gRPC and Finagle use. Every first try earns
 * `budget` of a retry, every retry costs a whole one, and a retry with less than
 * a whole one to spend is not made — the request fails instead. The bucket holds
 * at most `RETRY_BUDGET_BURST`, so a quiet minute cannot save up the licence for
 * a storm, and it starts full, so a caller's first few failures can be retried.
 * Kept per caller and per thing called, and in nothing random: the same run
 * spends the same budget the same way.
 */
export const RETRY_BUDGET_BURST = 10;

export interface RetryBudget {
  tokens: number;
}

export function createRetryBudget(): RetryBudget {
  return { tokens: RETRY_BUDGET_BURST };
}

/** A first try earns its share of a retry. */
export function earnRetry(budget: RetryBudget, retry: RetrySpec): void {
  if ((retry.budget ?? 0) > 0) budget.tokens = Math.min(RETRY_BUDGET_BURST, budget.tokens + (retry.budget ?? 0));
}

/** Whether a retry may be made, spending for it if so. Always, with no budget set. */
export function spendRetry(budget: RetryBudget, retry: RetrySpec): boolean {
  if ((retry.budget ?? 0) <= 0) return true;
  if (budget.tokens < 1) return false;
  budget.tokens -= 1;
  return true;
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

/**
 * Set how long to wait before the first retry. Every later wait is derived from
 * it by the policy's factor, so this is the one spacing an author states.
 */
export function withRetryDelay(retry: RetrySpec, seconds: number): RetrySpec {
  if (!Number.isFinite(seconds) || seconds < 0) {
    throw new Error(`a retry delay must be a non-negative number of seconds, got ${seconds}`);
  }
  return { ...retry, delay: seconds };
}

/** Set the retry budget as a share of requests. `null` takes the budget off. */
export function withRetryBudget(retry: RetrySpec, share: number | null): RetrySpec {
  if (share === null) return { ...retry, budget: 0 };
  if (!Number.isFinite(share) || share <= 0 || share > 1) {
    throw new Error(`a retry budget must be a share above 0 and at most 1, got ${share}`);
  }
  return { ...retry, budget: share };
}
