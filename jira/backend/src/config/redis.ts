import Redis from 'ioredis';
import { config } from './index.js';

/**
 * Redis client instance for caching and session storage.
 * Used throughout the application for caching frequently accessed data
 * (projects, workflows) and storing user sessions.
 */
export const redis = new Redis(config.redis.url);

redis.on('error', (err) => {
  console.error('Redis connection error:', err);
});

redis.on('connect', () => {
  console.log('Connected to Redis');
});

/**
 * Retrieves and deserializes a cached value by key.
 *
 * @template T - Expected type of the cached value
 * @param key - Cache key to look up
 * @returns Promise resolving to the cached value or null if not found
 */
export async function cacheGet<T>(key: string): Promise<T | null> {
  const data = await redis.get(key);
  if (!data) return null;
  return JSON.parse(data) as T;
}

/**
 * Serializes and stores a value in cache with optional TTL.
 *
 * @param key - Cache key to store under
 * @param value - Value to cache (will be JSON serialized)
 * @param ttlSeconds - Time-to-live in seconds (default: 1 hour)
 */
export async function cacheSet(
  key: string,
  value: unknown,
  ttlSeconds: number = 3600
): Promise<void> {
  await redis.setex(key, ttlSeconds, JSON.stringify(value));
}

/**
 * Deletes a single key from the cache.
 *
 * @param key - Cache key to delete
 */
export async function cacheDel(key: string): Promise<void> {
  await redis.del(key);
}

/**
 * Deletes all keys matching a pattern from the cache.
 * Useful for invalidating related cache entries (e.g., all project data).
 *
 * @param pattern - Redis glob-style pattern to match keys
 */
export async function cacheDelPattern(pattern: string): Promise<void> {
  const keys = await redis.keys(pattern);
  if (keys.length > 0) {
    await redis.del(...keys);
  }
}
