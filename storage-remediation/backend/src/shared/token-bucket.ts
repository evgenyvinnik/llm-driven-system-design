/**
 * Token bucket math shared by the cloud simulator (platform limits), the
 * executor's in-memory bucket store (tests) and, in Lua, the Valkey-backed
 * bucket the executor uses at runtime (executor/buckets.ts). Kept pure: the
 * caller passes the clock.
 * @module shared/token-bucket
 */

export interface BucketConfig {
  capacity: number
  refillPerSec: number
}

export interface BucketState {
  tokens: number
  updatedAt: number
}

export interface TakeResult {
  ok: boolean
  /** Milliseconds until `cost` tokens will be available (0 when ok). */
  waitMs: number
  state: BucketState
}

export function refill(state: BucketState | undefined, cfg: BucketConfig, now: number): BucketState {
  if (!state) return { tokens: cfg.capacity, updatedAt: now }
  const elapsed = Math.max(0, now - state.updatedAt) / 1000
  return { tokens: Math.min(cfg.capacity, state.tokens + elapsed * cfg.refillPerSec), updatedAt: now }
}

export function take(state: BucketState | undefined, cfg: BucketConfig, now: number, cost = 1): TakeResult {
  const current = refill(state, cfg, now)
  if (current.tokens >= cost) {
    return { ok: true, waitMs: 0, state: { tokens: current.tokens - cost, updatedAt: now } }
  }
  const missing = cost - current.tokens
  return { ok: false, waitMs: Math.ceil((missing / cfg.refillPerSec) * 1000), state: current }
}

/**
 * Parses the server's back-off instruction. ARM sends `Retry-After` in seconds
 * (sometimes an HTTP date); Resource Graph sends `x-ms-user-quota-resets-after`
 * as hh:mm:ss. Returns milliseconds, or `fallbackMs` when nothing usable is present.
 */
export function parseRetryAfter(headers: { get(name: string): string | null }, now: number, fallbackMs = 1000): number {
  const retryAfter = headers.get('retry-after')
  if (retryAfter) {
    const seconds = Number(retryAfter)
    if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1000)
    const date = Date.parse(retryAfter)
    if (Number.isFinite(date)) return Math.max(0, date - now)
  }
  const quotaReset = headers.get('x-ms-user-quota-resets-after')
  if (quotaReset) {
    const match = /^(\d+):(\d{2}):(\d{2})(?:\.\d+)?$/.exec(quotaReset)
    if (match) return ((Number(match[1]) * 60 + Number(match[2])) * 60 + Number(match[3])) * 1000 || 1000
  }
  return fallbackMs
}
