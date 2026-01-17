/**
 * @fileoverview Redis caching module with cache-aside and write-through patterns.
 * Provides caching for page content, workspace data, and blocks to reduce
 * database load for frequently accessed pages.
 */

import redis from '../models/redis.js';
import { logger, LogEvents, logEvent } from './logger.js';
import { cacheHitsCounter, cacheMissesCounter, cacheOperationDuration } from './metrics.js';

/**
 * Cache key prefixes for different data types.
 */
export const CACHE_KEYS = {
  page: (pageId: string) => `cache:page:${pageId}`,
  pageWithBlocks: (pageId: string) => `cache:page:${pageId}:full`,
  blocks: (pageId: string) => `cache:blocks:${pageId}`,
  workspace: (workspaceId: string) => `cache:workspace:${workspaceId}`,
  workspaceMembers: (workspaceId: string) => `cache:workspace:${workspaceId}:members`,
  workspacePages: (workspaceId: string) => `cache:workspace:${workspaceId}:pages`,
  searchResults: (workspaceId: string, queryHash: string) => `cache:search:${workspaceId}:${queryHash}`,
} as const;

/**
 * Cache TTL configuration in seconds.
 */
export const CACHE_TTL = {
  page: parseInt(process.env.CACHE_TTL_PAGE || '300', 10), // 5 minutes
  blocks: parseInt(process.env.CACHE_TTL_BLOCKS || '600', 10), // 10 minutes
  workspace: parseInt(process.env.CACHE_TTL_WORKSPACE || '900', 10), // 15 minutes
  search: parseInt(process.env.CACHE_TTL_SEARCH || '120', 10), // 2 minutes
} as const;

/**
 * Generic cache-aside pattern implementation.
 * Tries cache first, falls back to fetcher on miss, then caches the result.
 */
export async function cacheAside<T>(
  cacheKey: string,
  ttl: number,
  fetcher: () => Promise<T>,
  cacheType: string = 'generic'
): Promise<T> {
  const startTime = Date.now();

  try {
    // Try cache first
    const cached = await redis.get(cacheKey);
    if (cached) {
      cacheHitsCounter.inc({ cache_type: cacheType });
      logEvent(LogEvents.CACHE_HIT, { cacheKey, cacheType });
      cacheOperationDuration.observe({ operation: 'get', cache_type: cacheType }, (Date.now() - startTime) / 1000);
      return JSON.parse(cached) as T;
    }

    // Cache miss: fetch from source
    cacheMissesCounter.inc({ cache_type: cacheType });
    logEvent(LogEvents.CACHE_MISS, { cacheKey, cacheType });

    const data = await fetcher();

    // Store in cache
    if (data !== null && data !== undefined) {
      await redis.setex(cacheKey, ttl, JSON.stringify(data));
      cacheOperationDuration.observe({ operation: 'set', cache_type: cacheType }, (Date.now() - startTime) / 1000);
    }

    return data;
  } catch (error) {
    logger.error({ error, cacheKey, cacheType }, 'Cache operation failed, falling back to fetcher');
    // On cache error, fall back to fetcher
    return fetcher();
  }
}

/**
 * Write-through cache pattern for critical data.
 * Writes to both cache and database simultaneously.
 */
export async function writeThrough<T>(
  cacheKey: string,
  ttl: number,
  data: T,
  cacheType: string = 'generic'
): Promise<void> {
  const startTime = Date.now();
  try {
    await redis.setex(cacheKey, ttl, JSON.stringify(data));
    cacheOperationDuration.observe({ operation: 'set', cache_type: cacheType }, (Date.now() - startTime) / 1000);
    logger.debug({ cacheKey, cacheType }, 'Write-through cache updated');
  } catch (error) {
    logger.error({ error, cacheKey, cacheType }, 'Write-through cache failed');
    // Don't throw - the data is already in the database
  }
}

/**
 * Invalidates cache for a specific key.
 */
export async function invalidateCache(cacheKey: string): Promise<void> {
  try {
    await redis.del(cacheKey);
    logger.debug({ cacheKey }, 'Cache invalidated');
  } catch (error) {
    logger.error({ error, cacheKey }, 'Cache invalidation failed');
  }
}

/**
 * Invalidates all caches related to a page (page data, blocks, etc.).
 */
export async function invalidatePageCache(pageId: string): Promise<void> {
  const keys = [
    CACHE_KEYS.page(pageId),
    CACHE_KEYS.pageWithBlocks(pageId),
    CACHE_KEYS.blocks(pageId),
  ];

  try {
    await Promise.all(keys.map((key) => redis.del(key)));
    logger.debug({ pageId, keysInvalidated: keys.length }, 'Page cache invalidated');
  } catch (error) {
    logger.error({ error, pageId }, 'Page cache invalidation failed');
  }
}

/**
 * Invalidates all caches related to a workspace.
 */
export async function invalidateWorkspaceCache(workspaceId: string): Promise<void> {
  const keys = [
    CACHE_KEYS.workspace(workspaceId),
    CACHE_KEYS.workspaceMembers(workspaceId),
    CACHE_KEYS.workspacePages(workspaceId),
  ];

  try {
    await Promise.all(keys.map((key) => redis.del(key)));
    logger.debug({ workspaceId, keysInvalidated: keys.length }, 'Workspace cache invalidated');
  } catch (error) {
    logger.error({ error, workspaceId }, 'Workspace cache invalidation failed');
  }
}

/**
 * Invalidates search result caches for a workspace.
 * Uses pattern matching to clear all search results.
 */
export async function invalidateSearchCache(workspaceId: string): Promise<void> {
  try {
    const pattern = `cache:search:${workspaceId}:*`;
    const keys = await redis.keys(pattern);
    if (keys.length > 0) {
      await redis.del(...keys);
      logger.debug({ workspaceId, keysInvalidated: keys.length }, 'Search cache invalidated');
    }
  } catch (error) {
    logger.error({ error, workspaceId }, 'Search cache invalidation failed');
  }
}

/**
 * Creates a hash of a search query for cache key generation.
 */
export function hashSearchQuery(query: string): string {
  let hash = 0;
  for (let i = 0; i < query.length; i++) {
    const char = query.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32-bit integer
  }
  return Math.abs(hash).toString(36);
}

export default {
  cacheAside,
  writeThrough,
  invalidateCache,
  invalidatePageCache,
  invalidateWorkspaceCache,
  invalidateSearchCache,
  hashSearchQuery,
  CACHE_KEYS,
  CACHE_TTL,
};
