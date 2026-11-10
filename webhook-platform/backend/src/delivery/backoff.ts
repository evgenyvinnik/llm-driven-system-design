/**
 * Retry delays.
 *
 * Full jitter: attempt n waits uniform(0, min(cap, base · 2^(n-1))). When an
 * endpoint comes back after an outage, thousands of deliveries that failed
 * together would otherwise retry together and knock it over again; full
 * jitter spreads them across the whole window. (Equal or decorrelated jitter
 * also work; full jitter has the lowest total work in the AWS analysis and is
 * the simplest to explain.)
 * @module delivery/backoff
 */

export function backoffCeilingMs(attempt: number, baseMs: number, capMs: number): number {
  const exp = Math.min(30, Math.max(0, attempt - 1))
  return Math.min(capMs, baseMs * 2 ** exp)
}

/** `attempt` is the number of the attempt that just failed (1-based). */
export function fullJitterDelayMs(attempt: number, baseMs: number, capMs: number, random: () => number = Math.random): number {
  return Math.floor(random() * backoffCeilingMs(attempt, baseMs, capMs))
}

/**
 * Retry-After is either delta-seconds or an HTTP date. Returns seconds from
 * `now`, or null when absent or unparseable.
 */
export function parseRetryAfter(value: string | string[] | undefined, now: Date = new Date()): number | null {
  const raw = Array.isArray(value) ? value[0] : value
  if (!raw) return null
  const trimmed = raw.trim()
  if (/^\d+$/.test(trimmed)) return Number(trimmed)
  const at = Date.parse(trimmed)
  if (Number.isNaN(at)) return null
  return Math.max(0, Math.ceil((at - now.getTime()) / 1000))
}
