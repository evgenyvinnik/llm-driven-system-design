/**
 * @fileoverview Redis cache utilities with metrics and consistent patterns.
 * Provides helper functions for common caching operations with automatic
 * hit/miss tracking and error handling.
 */

import { redis } from '../db/connection.js';
import { cacheOperationsTotal } from './metrics.js';
import { componentLoggers } from './logger.js';

const log = componentLoggers.cache;

/**
 * Cache key prefixes for organized namespacing.
 */
export const CACHE_KEYS = {
  SESSION: 'session',
  FEED: 'feed',
  CELEBRITY_POSTS: 'celebrity_posts',
  POST: 'post',
  USER: 'user',
  AFFINITY: 'affinity',
  IDEMPOTENCY: 'idempotency',
};

/**
 * Default TTLs for different cache types (in seconds).
 */
export const CACHE_TTL = {
  SESSION: 7 * 24 * 60 * 60, // 7 days
  FEED: 24 * 60 * 60, // 24 hours
  POST: 60 * 60, // 1 hour
  USER: 60 * 60, // 1 hour
  IDEMPOTENCY: 24 * 60 * 60, // 24 hours
};

/**
 * Result of a cache get operation.
 */
export interface CacheResult<T> {
  hit: boolean;
  value: T | null;
}

/**
 * Gets a value from cache with automatic metrics tracking.
 *
 * @param cacheName - Name of the cache for metrics
 * @param key - Full cache key
 * @returns CacheResult with hit status and value
 */
export async function cacheGet<T>(
  cacheName: string,
  key: string
): Promise<CacheResult<T>> {
  try {
    const value = await redis.get(key);

    if (value !== null) {
      cacheOperationsTotal.labels(cacheName, 'hit').inc();
      log.debug({ key, cacheName }, 'Cache hit');
      return { hit: true, value: JSON.parse(value) as T };
    }

    cacheOperationsTotal.labels(cacheName, 'miss').inc();
    log.debug({ key, cacheName }, 'Cache miss');
    return { hit: false, value: null };
  } catch (error) {
    log.error({ error, key, cacheName }, 'Cache get error');
    cacheOperationsTotal.labels(cacheName, 'miss').inc();
    return { hit: false, value: null };
  }
}

/**
 * Sets a value in cache with optional TTL.
 *
 * @param key - Full cache key
 * @param value - Value to cache (will be JSON serialized)
 * @param ttlSeconds - Optional TTL in seconds
 */
export async function cacheSet<T>(
  key: string,
  value: T,
  ttlSeconds?: number
): Promise<void> {
  try {
    const serialized = JSON.stringify(value);
    if (ttlSeconds) {
      await redis.setex(key, ttlSeconds, serialized);
    } else {
      await redis.set(key, serialized);
    }
    log.debug({ key, ttl: ttlSeconds }, 'Cache set');
  } catch (error) {
    log.error({ error, key }, 'Cache set error');
  }
}

/**
 * Deletes a value from cache.
 *
 * @param key - Full cache key
 */
export async function cacheDelete(key: string): Promise<void> {
  try {
    await redis.del(key);
    log.debug({ key }, 'Cache delete');
  } catch (error) {
    log.error({ error, key }, 'Cache delete error');
  }
}

/**
 * Gets multiple values from cache.
 *
 * @param cacheName - Name of the cache for metrics
 * @param keys - Array of cache keys
 * @returns Map of key to value (null for misses)
 */
export async function cacheGetMany<T>(
  cacheName: string,
  keys: string[]
): Promise<Map<string, T | null>> {
  const result = new Map<string, T | null>();

  if (keys.length === 0) {
    return result;
  }

  try {
    const values = await redis.mget(...keys);

    keys.forEach((key, index) => {
      const value = values[index];
      if (value !== null) {
        cacheOperationsTotal.labels(cacheName, 'hit').inc();
        result.set(key, JSON.parse(value) as T);
      } else {
        cacheOperationsTotal.labels(cacheName, 'miss').inc();
        result.set(key, null);
      }
    });
  } catch (error) {
    log.error({ error, keys }, 'Cache mget error');
    keys.forEach((key) => result.set(key, null));
  }

  return result;
}

/**
 * Gets cached feed items for a user.
 *
 * @param userId - User ID to get feed for
 * @param limit - Maximum number of items to return
 * @param maxScore - Optional maximum score for pagination
 * @returns Array of post IDs from cache, or null if cache miss
 */
export async function getFeedFromCache(
  userId: string,
  limit: number,
  maxScore?: number
): Promise<string[] | null> {
  const key = `${CACHE_KEYS.FEED}:${userId}`;

  try {
    const args: (string | number)[] = [key];
    if (maxScore !== undefined) {
      args.push(maxScore.toString(), '-inf', 'LIMIT', '0', limit.toString());
    } else {
      args.push('+inf', '-inf', 'LIMIT', '0', limit.toString());
    }

    const postIds = await redis.zrevrangebyscore(key, ...args);

    if (postIds.length > 0) {
      cacheOperationsTotal.labels('feed', 'hit').inc();
      log.debug({ userId, count: postIds.length }, 'Feed cache hit');
      return postIds;
    }

    cacheOperationsTotal.labels('feed', 'miss').inc();
    log.debug({ userId }, 'Feed cache miss');
    return null;
  } catch (error) {
    log.error({ error, userId }, 'Get feed from cache error');
    cacheOperationsTotal.labels('feed', 'miss').inc();
    return null;
  }
}

/**
 * Sets cached feed items for a user.
 *
 * @param userId - User ID to set feed for
 * @param items - Array of { postId, score } objects
 * @param ttlSeconds - TTL in seconds (default 24 hours)
 */
export async function setFeedCache(
  userId: string,
  items: Array<{ postId: string; score: number }>,
  ttlSeconds: number = CACHE_TTL.FEED
): Promise<void> {
  if (items.length === 0) return;

  const key = `${CACHE_KEYS.FEED}:${userId}`;

  try {
    const pipeline = redis.pipeline();

    // Add all items to sorted set
    const args: (string | number)[] = [];
    for (const item of items) {
      args.push(item.score, item.postId);
    }
    pipeline.zadd(key, ...args);

    // Trim to keep only most recent items
    pipeline.zremrangebyrank(key, 0, -1001); // Keep top 1000

    // Set expiry
    pipeline.expire(key, ttlSeconds);

    await pipeline.exec();
    log.debug({ userId, count: items.length }, 'Feed cache set');
  } catch (error) {
    log.error({ error, userId }, 'Set feed cache error');
  }
}

/**
 * Invalidates a user's feed cache.
 *
 * @param userId - User ID whose feed cache to invalidate
 */
export async function invalidateFeedCache(userId: string): Promise<void> {
  const key = `${CACHE_KEYS.FEED}:${userId}`;
  await cacheDelete(key);
}

/**
 * Checks if an idempotency key exists and returns the stored response if so.
 *
 * @param idempotencyKey - Client-provided idempotency key
 * @returns Stored response if key exists, null otherwise
 */
export async function getIdempotencyResponse<T>(
  idempotencyKey: string
): Promise<CacheResult<T>> {
  const key = `${CACHE_KEYS.IDEMPOTENCY}:${idempotencyKey}`;
  return cacheGet<T>('idempotency', key);
}

/**
 * Stores a response for an idempotency key.
 *
 * @param idempotencyKey - Client-provided idempotency key
 * @param response - Response to store
 * @param ttlSeconds - TTL in seconds (default 24 hours)
 */
export async function setIdempotencyResponse<T>(
  idempotencyKey: string,
  response: T,
  ttlSeconds: number = CACHE_TTL.IDEMPOTENCY
): Promise<void> {
  const key = `${CACHE_KEYS.IDEMPOTENCY}:${idempotencyKey}`;
  await cacheSet(key, response, ttlSeconds);
}
