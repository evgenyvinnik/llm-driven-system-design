/**
 * Cache TTL helpers.
 *
 * A cached copy of something that expires (a short link, a session) must never outlive
 * the thing itself. These helpers turn an absolute expiry into a Redis TTL that is the
 * smaller of the configured ceiling and the time remaining.
 */

/**
 * Computes the TTL (in whole seconds) for caching a value that expires at `expiresAtMs`.
 * Rounds down so the cache entry disappears at or before the real expiry.
 *
 * @param expiresAtMs - Absolute expiry in epoch milliseconds, or null for "never expires"
 * @param nowMs - Current time in epoch milliseconds
 * @param maxTtlSeconds - Configured ceiling for the cache TTL
 * @returns TTL in seconds; 0 means "do not cache" (already expired or under a second left)
 */
export function boundedTtlSeconds(
  expiresAtMs: number | null,
  nowMs: number,
  maxTtlSeconds: number
): number {
  if (expiresAtMs === null) {
    return maxTtlSeconds;
  }

  const remainingSeconds = Math.floor((expiresAtMs - nowMs) / 1000);
  if (!Number.isFinite(remainingSeconds) || remainingSeconds <= 0) {
    return 0;
  }

  return Math.min(maxTtlSeconds, remainingSeconds);
}
