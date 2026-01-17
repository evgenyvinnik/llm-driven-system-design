/**
 * Enhanced Redis caching with metrics and typed helpers.
 * Provides feed caching to reduce database load and improve response times.
 * @module shared/cache
 */

import { redis } from '../db/redis.js';
import { logger } from './logger.js';
import { cacheHitsTotal, cacheMissesTotal } from './metrics.js';

/**
 * Cache key prefixes for different data types.
 */
export const CacheKeys = {
  /** Personalized user feed cache */
  userFeed: (userId: string, cursor: string, limit: number) =>
    `feed:user:${userId}:${cursor}:${limit}`,
  /** Anonymous/global feed cache */
  globalFeed: (cursor: string, limit: number) =>
    `feed:global:${cursor}:${limit}`,
  /** Topic-specific feed cache */
  topicFeed: (topic: string, cursor: string, limit: number) =>
    `feed:topic:${topic}:${cursor}:${limit}`,
  /** Breaking news cache */
  breakingNews: () => 'feed:breaking',
  /** Trending stories cache */
  trending: () => 'feed:trending',
  /** User preferences cache */
  userPrefs: (userId: string) => `user:${userId}:prefs`,
  /** Story detail cache */
  story: (storyId: string) => `story:${storyId}`,
  /** Source list cache */
  sourceList: () => 'sources:list',
} as const;

/**
 * Default TTL values in seconds for different cache types.
 */
export const CacheTTL = {
  /** Short TTL for frequently changing data */
  short: 30,
  /** Medium TTL for moderately changing data */
  medium: 60,
  /** Long TTL for slowly changing data */
  long: 300,
  /** Feed cache TTL (60 seconds as per architecture) */
  feed: 60,
  /** User preferences cache TTL */
  userPrefs: 300,
  /** Breaking news TTL (short for real-time updates) */
  breaking: 30,
  /** Trending cache TTL */
  trending: 60,
  /** Story detail cache TTL */
  story: 120,
} as const;

/**
 * Get a cached value with metrics tracking.
 * Automatically tracks cache hits and misses for observability.
 *
 * @param key - The cache key
 * @param cacheType - Type of cache for metrics labeling
 * @returns Cached value or null if not found
 */
export async function getFromCache<T>(
  key: string,
  cacheType: string = 'default'
): Promise<T | null> {
  try {
    const data = await redis.get(key);

    if (data) {
      cacheHitsTotal.inc({ cache_type: cacheType });
      logger.debug({ key, cacheType }, 'Cache hit');
      return JSON.parse(data) as T;
    }

    cacheMissesTotal.inc({ cache_type: cacheType });
    logger.debug({ key, cacheType }, 'Cache miss');
    return null;
  } catch (error) {
    logger.error({ key, error }, 'Cache get error');
    cacheMissesTotal.inc({ cache_type: cacheType });
    return null;
  }
}

/**
 * Set a value in cache with TTL.
 *
 * @param key - The cache key
 * @param value - Value to cache (will be JSON serialized)
 * @param ttlSeconds - Time-to-live in seconds
 */
export async function setInCache(
  key: string,
  value: unknown,
  ttlSeconds: number = CacheTTL.medium
): Promise<void> {
  try {
    await redis.setex(key, ttlSeconds, JSON.stringify(value));
    logger.debug({ key, ttlSeconds }, 'Cache set');
  } catch (error) {
    logger.error({ key, error }, 'Cache set error');
  }
}

/**
 * Delete a value from cache.
 * Use for cache invalidation when data changes.
 *
 * @param key - The cache key to delete
 */
export async function deleteFromCache(key: string): Promise<void> {
  try {
    await redis.del(key);
    logger.debug({ key }, 'Cache delete');
  } catch (error) {
    logger.error({ key, error }, 'Cache delete error');
  }
}

/**
 * Delete multiple keys matching a pattern.
 * Useful for invalidating all feed caches for a user.
 *
 * @param pattern - Redis glob pattern (e.g., 'feed:user:123:*')
 */
export async function deleteByPattern(pattern: string): Promise<void> {
  try {
    const keys = await redis.keys(pattern);
    if (keys.length > 0) {
      await redis.del(...keys);
      logger.debug({ pattern, count: keys.length }, 'Cache pattern delete');
    }
  } catch (error) {
    logger.error({ pattern, error }, 'Cache pattern delete error');
  }
}

/**
 * Get or set pattern: Try cache first, compute and cache on miss.
 * This is the primary pattern for feed caching.
 *
 * @param key - The cache key
 * @param ttlSeconds - TTL for cached value
 * @param cacheType - Type label for metrics
 * @param computeFn - Function to compute value on cache miss
 * @returns Cached or computed value
 */
export async function getOrSet<T>(
  key: string,
  ttlSeconds: number,
  cacheType: string,
  computeFn: () => Promise<T>
): Promise<{ value: T; cached: boolean }> {
  // Try cache first
  const cached = await getFromCache<T>(key, cacheType);
  if (cached !== null) {
    return { value: cached, cached: true };
  }

  // Cache miss - compute value
  const value = await computeFn();

  // Store in cache (non-blocking)
  setInCache(key, value, ttlSeconds).catch(error => {
    logger.error({ key, error }, 'Failed to cache computed value');
  });

  return { value, cached: false };
}

/**
 * Invalidate all feed caches for a user.
 * Called when user preferences change.
 *
 * @param userId - The user's ID
 */
export async function invalidateUserFeedCache(userId: string): Promise<void> {
  await deleteByPattern(`feed:user:${userId}:*`);
  await deleteFromCache(CacheKeys.userPrefs(userId));
  logger.info({ userId }, 'User feed cache invalidated');
}

/**
 * Invalidate global and topic caches.
 * Called after crawling new articles.
 */
export async function invalidateGlobalCaches(): Promise<void> {
  await Promise.all([
    deleteByPattern('feed:global:*'),
    deleteByPattern('feed:topic:*'),
    deleteFromCache(CacheKeys.breakingNews()),
    deleteFromCache(CacheKeys.trending()),
    deleteFromCache(CacheKeys.sourceList()),
  ]);
  logger.info('Global feed caches invalidated');
}

/**
 * Warm up cache with commonly requested data.
 * Can be called on startup or after cache flush.
 *
 * @param warmupFn - Function that fetches data to cache
 */
export async function warmupCache(
  warmupFn: () => Promise<void>
): Promise<void> {
  try {
    logger.info('Starting cache warmup');
    await warmupFn();
    logger.info('Cache warmup completed');
  } catch (error) {
    logger.error({ error }, 'Cache warmup failed');
  }
}

/**
 * Get cache statistics for monitoring.
 * Returns info about Redis connection and memory usage.
 */
export async function getCacheStats(): Promise<{
  connected: boolean;
  memoryUsage?: string;
  keyCount?: number;
}> {
  try {
    const info = await redis.info('memory');
    const keyCount = await redis.dbsize();

    // Parse memory usage from info
    const memoryMatch = info.match(/used_memory_human:(\S+)/);
    const memoryUsage = memoryMatch ? memoryMatch[1] : undefined;

    return {
      connected: true,
      memoryUsage,
      keyCount,
    };
  } catch (error) {
    logger.error({ error }, 'Failed to get cache stats');
    return { connected: false };
  }
}
