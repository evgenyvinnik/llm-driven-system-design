/**
 * Token bucket math (the TypeScript mirror of the Lua in shared/cache.ts).
 * Limits are configured per minute; buckets refill continuously and hold one
 * minute of budget as burst. Costs are in tokens: estimated input + max_tokens.
 * @module shared/bucket
 */

export interface BucketState {
  tokens: number
  updatedAt: number
}

export interface BucketLimits {
  /** Refill per millisecond. */
  ratePerMs: number
  capacity: number
}

export function limitsPerMinute(perMinute: number): BucketLimits {
  return { ratePerMs: perMinute / 60_000, capacity: perMinute }
}

/** Level after refilling to `now`. A missing bucket starts full. */
export function bucketLevel(state: BucketState | null, now: number, limits: BucketLimits): number {
  if (!state) return limits.capacity
  const elapsed = Math.max(0, now - state.updatedAt)
  return Math.min(limits.capacity, state.tokens + elapsed * limits.ratePerMs)
}

export type ChargeResult =
  | { ok: true; remaining: number }
  | { ok: false; reason: 'too_large' | 'insufficient'; retryAfterMs: number; level: number }

/** Charges `cost`, or says how long until it would fit. */
export function charge(state: BucketState | null, now: number, limits: BucketLimits, cost: number): ChargeResult {
  if (cost > limits.capacity) return { ok: false, reason: 'too_large', retryAfterMs: 0, level: limits.capacity }
  const level = bucketLevel(state, now, limits)
  if (level < cost) {
    return { ok: false, reason: 'insufficient', retryAfterMs: Math.ceil((cost - level) / limits.ratePerMs), level }
  }
  return { ok: true, remaining: level - cost }
}

/** Refund of the unused reservation: never negative, never above capacity. */
export function refundAmount(reserved: number, actual: number): number {
  return Math.max(0, reserved - actual)
}

/** Retry-After header value in whole seconds (at least 1). */
export function retryAfterSeconds(ms: number): number {
  return Math.max(1, Math.ceil(ms / 1000))
}
