/**
 * @fileoverview Redis client and caching utilities.
 * Provides Redis connection, typed cache helpers, and standardized cache key generators.
 * Used for session storage, visibility set caching, and search suggestions.
 */

import Redis from 'ioredis';
import { config } from '../config/index.js';

/**
 * Redis client instance configured from environment settings.
 * Used for all caching and session storage operations.
 * @constant
 */
export const redis = new Redis(config.redis.url);

redis.on('error', (err) => {
  console.error('Redis connection error:', err);
});

redis.on('connect', () => {
  console.log('Connected to Redis');
});

/**
 * Retrieves and deserializes a cached value from Redis.
 * Automatically parses JSON values; returns raw string if parsing fails.
 * @template T - The expected type of the cached value
 * @param key - The cache key to retrieve
 * @returns Promise resolving to the cached value or null if not found
 */
export async function getCache<T>(key: string): Promise<T | null> {
  const value = await redis.get(key);
  if (!value) return null;
  try {
    return JSON.parse(value) as T;
  } catch {
    return value as unknown as T;
  }
}

/**
 * Stores a value in Redis cache with optional TTL.
 * Automatically serializes objects to JSON; strings are stored as-is.
 * @param key - The cache key to store under
 * @param value - The value to cache (will be JSON serialized if object)
 * @param ttlSeconds - Optional time-to-live in seconds; if omitted, key never expires
 * @returns Promise that resolves when the value is stored
 */
export async function setCache(
  key: string,
  value: unknown,
  ttlSeconds?: number
): Promise<void> {
  const serialized = typeof value === 'string' ? value : JSON.stringify(value);
  if (ttlSeconds) {
    await redis.setex(key, ttlSeconds, serialized);
  } else {
    await redis.set(key, serialized);
  }
}

/**
 * Removes a value from Redis cache.
 * @param key - The cache key to delete
 * @returns Promise that resolves when the key is deleted
 */
export async function deleteCache(key: string): Promise<void> {
  await redis.del(key);
}

/**
 * Factory functions for generating standardized cache keys.
 * Ensures consistent key naming across the application.
 * @constant
 */
export const cacheKeys = {
  userVisibility: (userId: string) => `visibility:${userId}`,
  searchSuggestions: (prefix: string) => `suggestions:${prefix}`,
  userSession: (sessionId: string) => `session:${sessionId}`,
  trendingSearches: () => 'trending:searches',
};
