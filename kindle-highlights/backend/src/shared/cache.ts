/**
 * Redis cache client
 * @module shared/cache
 */
import { createClient } from 'redis'

const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379'

/** Redis client instance */
export const redis = createClient({ url: redisUrl })

redis.on('error', (err) => console.error('Redis Client Error', err))

/** Connects to Redis and logs connection status. */
export async function initRedis(): Promise<void> {
  if (!redis.isOpen) {
    await redis.connect()
    console.log('Redis connected')
  }
}

/** Retrieves a cached JSON value from Redis by key. */
export async function cacheGet<T>(key: string): Promise<T | null> {
  const value = await redis.get(key)
  return value ? JSON.parse(value) : null
}

/** Stores a JSON value in Redis with an optional TTL. */
export async function cacheSet<T>(key: string, value: T, ttlSeconds?: number): Promise<void> {
  const serialized = JSON.stringify(value)
  if (ttlSeconds) {
    await redis.setEx(key, ttlSeconds, serialized)
  } else {
    await redis.set(key, serialized)
  }
}

/** Removes cached values from Redis. */
export async function cacheDel(...keys: string[]): Promise<void> {
  if (keys.length > 0) await redis.del(keys)
}

/**
 * Spreads a TTL by +/- `spread` (default 10%) so entries filled together don't all expire in
 * the same second and stampede the database.
 */
export function withJitter(ttlSeconds: number, spread = 0.1): number {
  const delta = ttlSeconds * spread
  return Math.max(1, Math.round(ttlSeconds - delta + Math.random() * 2 * delta))
}
