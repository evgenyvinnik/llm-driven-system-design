/**
 * Redis caching module.
 * Provides caching for frequently accessed data to reduce database load.
 * Used for session storage, admin stats, and shape lists.
 * @module shared/cache
 */

import Redis from 'ioredis'

/** Redis connection URL from environment or default */
const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379'

/**
 * Redis client instance with automatic retry strategy.
 * Stops retrying after 3 failed attempts to avoid blocking.
 */
export const redis = new Redis(redisUrl, {
  maxRetriesPerRequest: 3,
  retryStrategy: (times: number) => {
    if (times > 3) {
      console.error('Redis connection failed after 3 retries')
      return null // Stop retrying
    }
    return Math.min(times * 100, 3000)
  },
})

redis.on('connect', () => {
  console.log('Connected to Redis')
})

redis.on('error', (err: Error) => {
  console.error('Redis error:', err.message)
})

/**
 * Retrieves a cached value by key and deserializes it from JSON.
 * Returns null if the key doesn't exist or on error.
 *
 * @template T - Expected type of the cached value
 * @param key - Cache key to look up
 * @returns Promise resolving to the cached value or null
 */
export async function cacheGet<T>(key: string): Promise<T | null> {
  try {
    const data = await redis.get(key)
    if (!data) return null
    return JSON.parse(data) as T
  } catch (err) {
    console.error('Cache get error:', err)
    return null
  }
}

/**
 * Stores a value in the cache with a time-to-live.
 * Serializes the value to JSON before storing.
 *
 * @param key - Cache key to store under
 * @param value - Value to cache (will be JSON serialized)
 * @param ttlSeconds - Time to live in seconds (default: 60)
 * @returns Promise that resolves when value is stored
 */
export async function cacheSet(
  key: string,
  value: unknown,
  ttlSeconds = 60
): Promise<void> {
  try {
    await redis.setex(key, ttlSeconds, JSON.stringify(value))
  } catch (err) {
    console.error('Cache set error:', err)
  }
}

/**
 * Deletes a single key from the cache.
 * Used for cache invalidation when data changes.
 *
 * @param key - Cache key to delete
 * @returns Promise that resolves when key is deleted
 */
export async function cacheDelete(key: string): Promise<void> {
  try {
    await redis.del(key)
  } catch (err) {
    console.error('Cache delete error:', err)
  }
}

/**
 * Deletes all keys matching a pattern using Redis KEYS and DEL.
 * Useful for invalidating related cache entries at once.
 * Note: KEYS command can be slow on large datasets; use in moderation.
 *
 * @param pattern - Redis glob pattern (e.g., "user:*" to delete all user keys)
 * @returns Promise that resolves when matching keys are deleted
 */
export async function cacheDeletePattern(pattern: string): Promise<void> {
  try {
    const keys = await redis.keys(pattern)
    if (keys.length > 0) {
      await redis.del(...keys)
    }
  } catch (err) {
    console.error('Cache delete pattern error:', err)
  }
}

/**
 * Cache key generators for consistent naming across the application.
 * Centralizes key naming to prevent collisions and typos.
 */
export const CacheKeys = {
  /** Key for aggregated admin dashboard statistics */
  adminStats: () => 'admin:stats',

  /** Key for the list of available shapes */
  shapes: () => 'shapes:all',

  /** Key for user-specific statistics by session ID */
  userStats: (sessionId: string) => `user:stats:${sessionId}`,

  /** Key for individual drawing data by ID */
  drawing: (id: string) => `drawing:${id}`,
}
