/**
 * Fixed-window rate limiting in Valkey (INCR + EXPIRE). Used for login attempts.
 * @module shared/rate-limit
 */
import { redis } from './cache.js'
import { HttpError } from './errors.js'

export async function enforceRateLimit(key: string, limit: number, windowSeconds: number): Promise<void> {
  const bucket = `ratelimit:${key}:${Math.floor(Date.now() / (windowSeconds * 1000))}`
  const count = await redis.incr(bucket)
  if (count === 1) await redis.expire(bucket, windowSeconds)
  if (count > limit) throw new HttpError(429, 'RATE_LIMITED', 'Too many attempts; try again shortly')
}
