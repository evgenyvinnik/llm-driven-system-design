/**
 * @fileoverview Redis client configuration and caching utilities.
 * Provides cache operations and session management for the App Store.
 */

import Redis from 'ioredis';
import { config } from './index.js';

/**
 * Redis client instance for caching and session storage.
 * Used throughout the application for performance optimization.
 */
export const redis = new Redis(config.redis.url);

redis.on('error', (err) => {
  console.error('Redis error:', err);
});

redis.on('connect', () => {
  console.log('Connected to Redis');
});

/**
 * Retrieves a cached value by key, parsing JSON automatically.
 * @template T - Expected type of the cached value
 * @param key - Cache key to look up
 * @returns Parsed cached value or null if not found
 */
export async function cacheGet<T>(key: string): Promise<T | null> {
  const data = await redis.get(key);
  if (data) {
    return JSON.parse(data) as T;
  }
  return null;
}

/**
 * Stores a value in cache with automatic JSON serialization and TTL.
 * @param key - Cache key for storage
 * @param value - Value to cache (will be JSON serialized)
 * @param ttlSeconds - Time-to-live in seconds (default: 300)
 */
export async function cacheSet(key: string, value: unknown, ttlSeconds = 300): Promise<void> {
  await redis.setex(key, ttlSeconds, JSON.stringify(value));
}

/**
 * Removes a single key from the cache.
 * @param key - Cache key to delete
 */
export async function cacheDelete(key: string): Promise<void> {
  await redis.del(key);
}

/**
 * Removes all keys matching a pattern. Use sparingly due to KEYS command overhead.
 * @param pattern - Redis glob pattern (e.g., "reviews:*")
 */
export async function cacheDeletePattern(pattern: string): Promise<void> {
  const keys = await redis.keys(pattern);
  if (keys.length > 0) {
    await redis.del(...keys);
  }
}

/**
 * Creates or updates a user session with 24-hour expiration.
 * Sessions enable stateful authentication without JWT complexity.
 * @param sessionId - Unique session identifier (typically UUID)
 * @param userId - User ID to associate with session
 * @param data - Additional session data (e.g., role)
 */
export async function setSession(sessionId: string, userId: string, data: Record<string, unknown>): Promise<void> {
  const sessionData = { userId, ...data };
  await redis.setex(`session:${sessionId}`, 86400, JSON.stringify(sessionData)); // 24 hours
}

/**
 * Retrieves session data by session ID.
 * @param sessionId - Session identifier to look up
 * @returns Session data including userId, or null if expired/not found
 */
export async function getSession(sessionId: string): Promise<{ userId: string; [key: string]: unknown } | null> {
  const data = await redis.get(`session:${sessionId}`);
  if (data) {
    return JSON.parse(data);
  }
  return null;
}

/**
 * Removes a session from Redis, effectively logging out the user.
 * @param sessionId - Session identifier to invalidate
 */
export async function deleteSession(sessionId: string): Promise<void> {
  await redis.del(`session:${sessionId}`);
}
