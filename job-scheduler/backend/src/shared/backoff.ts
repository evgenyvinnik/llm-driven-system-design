/**
 * Retry policy: how many attempts a run gets and how long to wait between them.
 * Pure functions so the policy is unit tested independently of the queue.
 * @module shared/backoff
 */

/**
 * Whether a failed attempt gets another try.
 *
 * Attempts are 1-based and `maxRetries` counts retries after the first attempt, so a
 * job with max_retries = 3 runs at most 4 times. (The previous check,
 * `attempt < maxRetries`, made max_retries = 1 mean "never retry".)
 */
export function shouldRetry(attempt: number, maxRetries: number): boolean {
  return attempt <= maxRetries;
}

/**
 * Delay before the retry that follows `attempt`, using exponential backoff with
 * "equal jitter": a random value between half and all of
 * min(maxMs, initialMs * 2^(attempt - 1)).
 *
 * The exponential part backs off from a struggling dependency; the jitter spreads
 * out retries from jobs that failed together (same outage), so they don't hit the
 * recovering dependency in one synchronized wave. Keeping the lower half fixed
 * guarantees a minimum pause, which full jitter (0..cap) does not.
 *
 * @param random - injectable for tests; must return a value in [0, 1)
 */
export function computeBackoffMs(
  attempt: number,
  initialMs: number,
  maxMs: number,
  random: () => number = Math.random
): number {
  const exponent = Math.max(0, attempt - 1);
  const capped = Math.min(maxMs, initialMs * Math.pow(2, exponent));
  const half = capped / 2;
  return Math.round(half + random() * half);
}
