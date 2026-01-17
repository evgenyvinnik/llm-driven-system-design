import Redis from 'ioredis';
import { REDIS_CONFIG } from '../config.js';

/**
 * Redis client instance.
 * Provides connection to Redis for session storage and caching.
 * Configured with automatic retry strategy for connection resilience.
 */
export const redis = new Redis({
  host: REDIS_CONFIG.host,
  port: REDIS_CONFIG.port,
  retryStrategy: (times) => {
    const delay = Math.min(times * 50, 2000);
    return delay;
  },
});

redis.on('error', (err) => {
  console.error('Redis connection error:', err);
});

redis.on('connect', () => {
  console.log('Connected to Redis');
});

/** Key prefix for session tokens in Redis */
const SESSION_PREFIX = 'session:';
/** Session TTL: 7 days in seconds */
const SESSION_TTL = 7 * 24 * 60 * 60;

/**
 * Session data stored in Redis.
 * Contains account ID, optional profile selection, and device metadata.
 */
export interface Session {
  accountId: string;
  profileId?: string;
  deviceInfo?: {
    userAgent?: string;
    ip?: string;
  };
  createdAt: string;
}

/**
 * Stores a new session in Redis with automatic expiration.
 * Used after successful login to establish user authentication.
 *
 * @param token - Unique session token (UUID)
 * @param session - Session data including accountId and device info
 */
export async function setSession(token: string, session: Session): Promise<void> {
  await redis.setex(`${SESSION_PREFIX}${token}`, SESSION_TTL, JSON.stringify(session));
}

/**
 * Retrieves session data by token.
 * Used by auth middleware to validate requests.
 *
 * @param token - Session token from cookie
 * @returns Session data or null if token is invalid/expired
 */
export async function getSession(token: string): Promise<Session | null> {
  const data = await redis.get(`${SESSION_PREFIX}${token}`);
  if (!data) return null;
  return JSON.parse(data) as Session;
}

/**
 * Deletes a session from Redis.
 * Used during logout to invalidate the session.
 *
 * @param token - Session token to remove
 */
export async function deleteSession(token: string): Promise<void> {
  await redis.del(`${SESSION_PREFIX}${token}`);
}

/** Key prefix for cached data in Redis */
const CACHE_PREFIX = 'cache:';

/**
 * Retrieves cached data by key.
 * Used to avoid expensive database queries for frequently accessed data
 * like personalized homepage rows.
 *
 * @template T - Expected type of cached data
 * @param key - Cache key (without prefix)
 * @returns Cached data or null if not found/expired
 */
export async function getCached<T>(key: string): Promise<T | null> {
  const data = await redis.get(`${CACHE_PREFIX}${key}`);
  if (!data) return null;
  return JSON.parse(data) as T;
}

/**
 * Stores data in cache with TTL.
 * Used to cache expensive computations like personalized recommendations.
 *
 * @template T - Type of data to cache
 * @param key - Cache key (without prefix)
 * @param value - Data to cache (will be JSON-serialized)
 * @param ttlSeconds - Time-to-live in seconds (default: 5 minutes)
 */
export async function setCache<T>(key: string, value: T, ttlSeconds = 300): Promise<void> {
  await redis.setex(`${CACHE_PREFIX}${key}`, ttlSeconds, JSON.stringify(value));
}

/**
 * Deletes a specific cache entry.
 *
 * @param key - Cache key to delete (without prefix)
 */
export async function deleteCache(key: string): Promise<void> {
  await redis.del(`${CACHE_PREFIX}${key}`);
}

/**
 * Deletes all cache entries matching a pattern.
 * Used to invalidate related cache entries (e.g., all homepage caches for a profile).
 *
 * @param pattern - Redis glob pattern (e.g., "homepage:*")
 */
export async function deleteCachePattern(pattern: string): Promise<void> {
  const keys = await redis.keys(`${CACHE_PREFIX}${pattern}`);
  if (keys.length > 0) {
    await redis.del(...keys);
  }
}
