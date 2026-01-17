/**
 * Redis connection and utilities for session management, caching, and real-time sync.
 * Uses separate connections for standard operations and pub/sub messaging.
 * @module utils/redis
 */

import Redis from 'ioredis';

/** Redis connection URL from environment or localhost default */
const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';

/** Primary Redis client for standard get/set operations */
export const redis = new Redis(redisUrl, {
  maxRetriesPerRequest: 3,
  retryDelayOnFailover: 100,
  retryDelayOnClusterDown: 100,
});

redis.on('error', (err) => {
  console.error('Redis connection error:', err);
});

redis.on('connect', () => {
  console.log('Connected to Redis');
});

// Session helpers

/**
 * Creates or updates a user session in Redis.
 * Sessions enable fast authentication without database lookups.
 * @param token - Unique session token (generated at login)
 * @param userId - ID of the authenticated user
 * @param expirySeconds - Time until session expires (typically 24 hours)
 */
export async function setSession(token: string, userId: string, expirySeconds: number): Promise<void> {
  await redis.setex(`session:${token}`, expirySeconds, userId);
}

/**
 * Retrieves the user ID associated with a session token.
 * Returns null for invalid or expired sessions.
 * @param token - Session token to look up
 * @returns User ID if session is valid, null otherwise
 */
export async function getSession(token: string): Promise<string | null> {
  return redis.get(`session:${token}`);
}

/**
 * Removes a session from Redis (logout).
 * @param token - Session token to delete
 */
export async function deleteSession(token: string): Promise<void> {
  await redis.del(`session:${token}`);
}

// Cache helpers

/**
 * Stores a value in the cache with automatic expiration.
 * Used for caching folder listings and other frequently-accessed data.
 * @param key - Cache key (will be prefixed with "cache:")
 * @param value - Any JSON-serializable value
 * @param expirySeconds - Time until cache expires (default 1 hour)
 */
export async function setCache(key: string, value: unknown, expirySeconds: number = 3600): Promise<void> {
  await redis.setex(`cache:${key}`, expirySeconds, JSON.stringify(value));
}

/**
 * Retrieves a cached value by key.
 * @param key - Cache key to look up
 * @returns Parsed JSON value of type T, or null if not cached
 */
export async function getCache<T>(key: string): Promise<T | null> {
  const data = await redis.get(`cache:${key}`);
  if (!data) return null;
  return JSON.parse(data) as T;
}

/**
 * Removes a value from the cache.
 * Called when cached data becomes stale (e.g., after file operations).
 * @param key - Cache key to delete
 */
export async function deleteCache(key: string): Promise<void> {
  await redis.del(`cache:${key}`);
}

// Pub/Sub for real-time sync notifications

/** Separate Redis client for subscribing to sync channels */
export const redisSub = new Redis(redisUrl);

/** Separate Redis client for publishing sync events */
export const redisPub = new Redis(redisUrl);

/**
 * Publishes a file sync event to notify connected clients.
 * Events are sent when files are created, updated, moved, or deleted.
 * Connected WebSocket clients receive these to update their UI in real-time.
 * @param userId - User ID to notify (channel name is sync:userId)
 * @param event - Event payload describing the file change
 */
export async function publishSync(userId: string, event: object): Promise<void> {
  await redisPub.publish(`sync:${userId}`, JSON.stringify(event));
}
