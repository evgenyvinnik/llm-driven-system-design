/**
 * Redis Client Module
 *
 * Provides Redis connections and helper functions for caching, pub/sub, and rate limiting.
 * Uses separate clients for different purposes since Redis requires dedicated connections
 * for blocking operations like SUBSCRIBE.
 *
 * @module utils/redis
 */

import Redis from 'ioredis';

const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';

/** Main Redis client for general caching and data operations */
export const redis = new Redis(redisUrl);

/**
 * Dedicated Redis client for Pub/Sub subscriber.
 * Separate connection required because SUBSCRIBE blocks the client.
 */
export const redisSub = new Redis(redisUrl);

/** Dedicated Redis client for Pub/Sub publisher */
export const redisPub = new Redis(redisUrl);

redis.on('connect', () => {
  console.log('Redis connected');
});

redis.on('error', (err) => {
  console.error('Redis error:', err);
});

/**
 * Retrieves and parses a cached JSON value from Redis.
 *
 * @template T - Expected type of the cached value
 * @param key - Redis key to look up
 * @returns Parsed value or null if not found
 */
export async function cacheGet<T>(key: string): Promise<T | null> {
  const value = await redis.get(key);
  if (!value) return null;
  return JSON.parse(value) as T;
}

/**
 * Stores a value in Redis cache as JSON.
 *
 * @param key - Redis key for storage
 * @param value - Value to serialize and store
 * @param ttlSeconds - Optional time-to-live in seconds
 */
export async function cacheSet(key: string, value: unknown, ttlSeconds?: number): Promise<void> {
  const serialized = JSON.stringify(value);
  if (ttlSeconds) {
    await redis.setex(key, ttlSeconds, serialized);
  } else {
    await redis.set(key, serialized);
  }
}

/**
 * Removes a key from Redis cache.
 *
 * @param key - Redis key to delete
 */
export async function cacheDelete(key: string): Promise<void> {
  await redis.del(key);
}

/**
 * Checks if an action is within rate limits using a sliding window counter.
 * Increments the counter and sets expiry on first access within the window.
 *
 * @param key - Unique key identifying the rate limit bucket (e.g., "ratelimit:user:123")
 * @param limit - Maximum allowed actions within the window
 * @param windowSeconds - Duration of the rate limit window in seconds
 * @returns true if action is allowed, false if rate limit exceeded
 */
export async function checkRateLimit(key: string, limit: number, windowSeconds: number): Promise<boolean> {
  const count = await redis.incr(key);
  if (count === 1) {
    await redis.expire(key, windowSeconds);
  }
  return count <= limit;
}
