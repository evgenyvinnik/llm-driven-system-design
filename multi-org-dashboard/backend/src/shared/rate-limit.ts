/**
 * Fixed-window rate limiting in Valkey. Shared by every API instance, so the
 * limit holds no matter which instance a request lands on.
 * @module shared/rate-limit
 */
import { redis } from './cache.js'
import { HttpError } from './errors.js'

export async function enforceRateLimit(bucket: string, limit: number, windowSeconds: number): Promise<void> {
  const window = Math.floor(Date.now() / 1000 / windowSeconds)
  const key = `ratelimit:${bucket}:${window}`
  const count = await redis.incr(key)
  if (count === 1) await redis.expire(key, windowSeconds + 1)
  if (count > limit) {
    const retryAfter = windowSeconds - (Math.floor(Date.now() / 1000) % windowSeconds)
    throw new HttpError(429, 'RATE_LIMITED', `Too many requests; try again in ${retryAfter}s`, { retryAfter })
  }
}
