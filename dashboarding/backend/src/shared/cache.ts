/**
 * @fileoverview Query result caching with Redis.
 *
 * Provides a caching layer for time-series query results to reduce database
 * load and improve response times. Uses a cache-aside pattern with
 * configurable TTLs based on data freshness requirements.
 *
 * WHY query caching reduces database load:
 * Dashboard panels typically refresh every 10-30 seconds, and multiple users
 * often view the same dashboard. Without caching, each panel refresh
 * triggers a full database query against large time-series tables.
 *
 * Query caching provides:
 * 1. Reduced database load: Identical queries within TTL window share results
 * 2. Improved latency: Cache hits return in <1ms vs 100-500ms for DB queries
 * 3. Better scalability: Cache can handle 10-100x more requests than DB
 * 4. Protection during traffic spikes: Cache absorbs sudden load increases
 *
 * Cache invalidation strategy:
 * - Time-based expiry (TTL) for simplicity
 * - Short TTL (10-30s) for live data to balance freshness vs performance
 * - Long TTL (5-60min) for historical data that doesn't change
 */

import crypto from 'crypto';
import redis from '../db/redis.js';
import logger from './logger.js';
import { cacheOperations } from './metrics.js';

/**
 * Cache configuration options.
 */
interface CacheConfig {
  /** Default TTL in seconds for cached items */
  defaultTtl: number;
  /** TTL for historical query results (queries ending before 1 hour ago) */
  historicalTtl: number;
  /** TTL for live/recent query results */
  liveTtl: number;
  /** Key prefix for all cache entries */
  keyPrefix: string;
  /** Maximum size of cacheable result in bytes */
  maxSize: number;
}

/**
 * Default cache configuration.
 */
const DEFAULT_CONFIG: CacheConfig = {
  defaultTtl: 60, // 1 minute default
  historicalTtl: 300, // 5 minutes for historical data
  liveTtl: 10, // 10 seconds for live data
  keyPrefix: 'cache:',
  maxSize: 1024 * 1024, // 1MB max cache entry
};

/**
 * Cache module configuration.
 */
let config: CacheConfig = { ...DEFAULT_CONFIG };

/**
 * Configures the cache module.
 *
 * @param newConfig - Partial configuration to merge with defaults
 */
export function configureCache(newConfig: Partial<CacheConfig>): void {
  config = { ...config, ...newConfig };
}

/**
 * Generates a deterministic cache key from query parameters.
 *
 * Uses SHA-256 hash of normalized query parameters to create a fixed-length
 * key that's consistent across requests with the same parameters.
 *
 * @param type - Cache type prefix (e.g., 'query', 'dashboard')
 * @param params - Object containing query parameters
 * @returns Redis cache key string
 */
export function generateCacheKey(type: string, params: Record<string, unknown>): string {
  // Sort object keys for consistent hashing
  const sortedParams = sortObjectKeys(params);
  const serialized = JSON.stringify(sortedParams);
  const hash = crypto.createHash('sha256').update(serialized).digest('hex').substring(0, 16);
  return `${config.keyPrefix}${type}:${hash}`;
}

/**
 * Recursively sorts object keys for consistent serialization.
 *
 * @param obj - Object to sort
 * @returns Object with sorted keys
 */
function sortObjectKeys(obj: unknown): unknown {
  if (obj === null || typeof obj !== 'object') {
    return obj;
  }

  if (Array.isArray(obj)) {
    return obj.map(sortObjectKeys);
  }

  const sorted: Record<string, unknown> = {};
  const keys = Object.keys(obj as Record<string, unknown>).sort();
  for (const key of keys) {
    sorted[key] = sortObjectKeys((obj as Record<string, unknown>)[key]);
  }
  return sorted;
}

/**
 * Determines the appropriate TTL based on query time range.
 *
 * Historical queries (ending more than 1 hour ago) get longer TTLs
 * since the data won't change. Live queries get shorter TTLs for freshness.
 *
 * @param endTime - Query end time
 * @returns TTL in seconds
 */
export function determineTtl(endTime?: Date): number {
  if (!endTime) {
    return config.defaultTtl;
  }

  const oneHourAgo = Date.now() - 60 * 60 * 1000;
  const isHistorical = endTime.getTime() < oneHourAgo;

  return isHistorical ? config.historicalTtl : config.liveTtl;
}

/**
 * Retrieves a cached value by key.
 *
 * @param key - Cache key
 * @returns Cached value or null if not found/expired
 */
export async function get<T>(key: string): Promise<T | null> {
  try {
    const data = await redis.get(key);

    if (data === null) {
      cacheOperations.inc({ operation: 'get', result: 'miss' });
      return null;
    }

    cacheOperations.inc({ operation: 'get', result: 'hit' });
    return JSON.parse(data) as T;
  } catch (error) {
    logger.error({ error, key }, 'Cache get error');
    cacheOperations.inc({ operation: 'get', result: 'error' });
    return null;
  }
}

/**
 * Stores a value in the cache with the specified TTL.
 *
 * @param key - Cache key
 * @param value - Value to cache
 * @param ttl - Time-to-live in seconds
 * @returns true if successful, false otherwise
 */
export async function set<T>(key: string, value: T, ttl: number = config.defaultTtl): Promise<boolean> {
  try {
    const serialized = JSON.stringify(value);

    // Check size limit
    if (serialized.length > config.maxSize) {
      logger.warn(
        { key, size: serialized.length, maxSize: config.maxSize },
        'Cache set skipped - value too large'
      );
      cacheOperations.inc({ operation: 'set', result: 'skipped_size' });
      return false;
    }

    await redis.set(key, serialized, 'EX', ttl);
    cacheOperations.inc({ operation: 'set', result: 'success' });
    return true;
  } catch (error) {
    logger.error({ error, key }, 'Cache set error');
    cacheOperations.inc({ operation: 'set', result: 'error' });
    return false;
  }
}

/**
 * Deletes a cached value by key.
 *
 * @param key - Cache key
 * @returns true if the key was deleted, false otherwise
 */
export async function del(key: string): Promise<boolean> {
  try {
    const result = await redis.del(key);
    cacheOperations.inc({ operation: 'delete', result: result > 0 ? 'success' : 'not_found' });
    return result > 0;
  } catch (error) {
    logger.error({ error, key }, 'Cache delete error');
    cacheOperations.inc({ operation: 'delete', result: 'error' });
    return false;
  }
}

/**
 * Deletes all cached values matching a pattern.
 *
 * Use with caution - SCAN can be slow on large Redis instances.
 *
 * @param pattern - Redis key pattern (e.g., 'cache:query:*')
 * @returns Number of keys deleted
 */
export async function deletePattern(pattern: string): Promise<number> {
  try {
    let cursor = '0';
    let deletedCount = 0;

    do {
      const [newCursor, keys] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
      cursor = newCursor;

      if (keys.length > 0) {
        await redis.del(...keys);
        deletedCount += keys.length;
      }
    } while (cursor !== '0');

    logger.info({ pattern, deletedCount }, 'Cache pattern delete completed');
    return deletedCount;
  } catch (error) {
    logger.error({ error, pattern }, 'Cache pattern delete error');
    return 0;
  }
}

/**
 * Cache-aside helper that gets from cache or executes the loader function.
 *
 * This is the primary way to use the cache - it handles the cache-aside
 * pattern automatically:
 * 1. Check cache for existing value
 * 2. If not found, execute loader function
 * 3. Store result in cache
 * 4. Return result
 *
 * @param key - Cache key
 * @param loader - Async function to load data if not cached
 * @param ttl - TTL in seconds (optional, uses default)
 * @returns Cached or freshly loaded value
 *
 * @example
 * const results = await getOrLoad(
 *   generateCacheKey('query', params),
 *   async () => executeQuery(params),
 *   determineTtl(params.endTime)
 * );
 */
export async function getOrLoad<T>(
  key: string,
  loader: () => Promise<T>,
  ttl?: number
): Promise<T> {
  // Try cache first
  const cached = await get<T>(key);
  if (cached !== null) {
    return cached;
  }

  // Load from source
  const value = await loader();

  // Cache the result (async, don't wait)
  set(key, value, ttl ?? config.defaultTtl).catch((error) => {
    logger.error({ error, key }, 'Failed to cache result');
  });

  return value;
}

/**
 * Invalidates cache entries related to a specific metric.
 *
 * Called after metric data is ingested to ensure fresh queries.
 *
 * @param metricName - Name of the metric that was updated
 */
export async function invalidateMetricCache(metricName: string): Promise<void> {
  // In a simple implementation, we rely on TTL expiry
  // For immediate invalidation, we'd need to track which cache keys
  // contain which metrics - adds complexity not needed for learning project
  logger.debug({ metricName }, 'Metric cache invalidation requested - relying on TTL');
}

/**
 * Invalidates cache entries for a specific dashboard.
 *
 * @param dashboardId - ID of the dashboard that was updated
 */
export async function invalidateDashboardCache(dashboardId: string): Promise<void> {
  const pattern = `${config.keyPrefix}dashboard:${dashboardId}:*`;
  await deletePattern(pattern);
}

/**
 * Gets cache statistics.
 *
 * @returns Object with cache statistics
 */
export async function getStats(): Promise<{
  hitRate: number;
  memoryUsage: number;
  keyCount: number;
}> {
  try {
    const info = await redis.info('memory');
    const usedMemory = parseInt(info.match(/used_memory:(\d+)/)?.[1] || '0');

    const keyCount = await redis.dbsize();

    // Note: Hit rate would need to be calculated from metrics counters
    // This is a placeholder that would need additional tracking
    return {
      hitRate: 0, // Would calculate from Prometheus metrics
      memoryUsage: usedMemory,
      keyCount,
    };
  } catch (error) {
    logger.error({ error }, 'Failed to get cache stats');
    return { hitRate: 0, memoryUsage: 0, keyCount: 0 };
  }
}

export default {
  configureCache,
  generateCacheKey,
  determineTtl,
  get,
  set,
  del,
  deletePattern,
  getOrLoad,
  invalidateMetricCache,
  invalidateDashboardCache,
  getStats,
};
