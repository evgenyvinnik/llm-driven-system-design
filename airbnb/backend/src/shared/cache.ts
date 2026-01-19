/**
 * Redis Cache Module with Cache-Aside Pattern
 *
 * Cache-aside (lazy loading) pattern:
 * 1. Check cache first
 * 2. On cache miss, fetch from database
 * 3. Store result in cache with TTL
 * 4. Return result
 *
 * Benefits:
 * - Reduces database load for read-heavy workloads
 * - Only caches data that is actually requested
 * - Graceful degradation if cache is unavailable
 */

import redisClient from '../redis.js';
import { metrics } from './metrics.js';

// TTL constants (in seconds)
export const CACHE_TTL = {
  LISTING: 900,        // 15 minutes - listing details change infrequently
  AVAILABILITY: 60,    // 1 minute - availability changes with bookings
  SEARCH: 300,         // 5 minutes - search results can be slightly stale
  USER_SESSION: 86400, // 24 hours - session data
  REVIEW: 1800,        // 30 minutes - reviews change rarely
};

// Cache key prefixes for organization and easier invalidation
export const CACHE_PREFIX = {
  LISTING: 'listing',
  AVAILABILITY: 'availability',
  SEARCH: 'search',
  USER: 'user',
  REVIEW: 'review',
};

/**
 * Get value from cache
 * @param {string} key - Cache key
 * @returns {Promise<any|null>} Cached value or null
 */
export async function cacheGet(key) {
  try {
    const value = await redisClient.get(key);
    if (value) {
      metrics.cacheHits.inc({ cache_type: key.split(':')[0] });
      return JSON.parse(value);
    }
    metrics.cacheMisses.inc({ cache_type: key.split(':')[0] });
    return null;
  } catch (error) {
    console.error('Cache get error:', error);
    metrics.cacheMisses.inc({ cache_type: key.split(':')[0] });
    return null;
  }
}

/**
 * Set value in cache with TTL
 * @param {string} key - Cache key
 * @param {any} value - Value to cache (will be JSON stringified)
 * @param {number} ttl - Time to live in seconds
 */
export async function cacheSet(key, value, ttl) {
  try {
    await redisClient.setEx(key, ttl, JSON.stringify(value));
  } catch (error) {
    console.error('Cache set error:', error);
  }
}

/**
 * Delete a cache key
 * @param {string} key - Cache key to delete
 */
export async function cacheDel(key) {
  try {
    await redisClient.del(key);
  } catch (error) {
    console.error('Cache delete error:', error);
  }
}

/**
 * Delete all keys matching a pattern
 * @param {string} pattern - Pattern to match (e.g., 'listing:123:*')
 */
export async function cacheDelPattern(pattern) {
  try {
    const keys = await redisClient.keys(pattern);
    if (keys.length > 0) {
      await redisClient.del(keys);
    }
  } catch (error) {
    console.error('Cache delete pattern error:', error);
  }
}

/**
 * Cache-aside helper - get from cache or fetch from source
 * @param {string} key - Cache key
 * @param {Function} fetchFn - Async function to fetch data if cache miss
 * @param {number} ttl - Time to live in seconds
 * @returns {Promise<any>} Data from cache or source
 */
export async function cacheAside(key, fetchFn, ttl) {
  // Try cache first
  const cached = await cacheGet(key);
  if (cached !== null) {
    return cached;
  }

  // Cache miss - fetch from source
  const data = await fetchFn();

  // Store in cache (don't await to avoid blocking)
  if (data !== null && data !== undefined) {
    cacheSet(key, data, ttl);
  }

  return data;
}

// Specific cache functions for different data types

/**
 * Get listing from cache or database
 * @param {number} listingId - Listing ID
 * @param {Function} fetchFn - Function to fetch from database
 */
export async function getCachedListing(listingId, fetchFn) {
  const key = `${CACHE_PREFIX.LISTING}:${listingId}`;
  return cacheAside(key, fetchFn, CACHE_TTL.LISTING);
}

/**
 * Invalidate listing cache
 * @param {number} listingId - Listing ID
 */
export async function invalidateListingCache(listingId) {
  const key = `${CACHE_PREFIX.LISTING}:${listingId}`;
  await cacheDel(key);
  // Also invalidate related search caches
  await cacheDelPattern(`${CACHE_PREFIX.SEARCH}:*`);
}

/**
 * Get availability from cache or database
 * @param {number} listingId - Listing ID
 * @param {string} startDate - Start date
 * @param {string} endDate - End date
 * @param {Function} fetchFn - Function to fetch from database
 */
export async function getCachedAvailability(listingId, startDate, endDate, fetchFn) {
  const key = `${CACHE_PREFIX.AVAILABILITY}:${listingId}:${startDate}:${endDate}`;
  return cacheAside(key, fetchFn, CACHE_TTL.AVAILABILITY);
}

/**
 * Invalidate availability cache for a listing
 * @param {number} listingId - Listing ID
 */
export async function invalidateAvailabilityCache(listingId) {
  await cacheDelPattern(`${CACHE_PREFIX.AVAILABILITY}:${listingId}:*`);
}

/**
 * Get search results from cache
 * @param {string} searchParams - Serialized search parameters
 * @param {Function} fetchFn - Function to fetch from database
 */
export async function getCachedSearchResults(searchParams, fetchFn) {
  // Create a hash of search params for the cache key
  const key = `${CACHE_PREFIX.SEARCH}:${Buffer.from(JSON.stringify(searchParams)).toString('base64').slice(0, 64)}`;
  return cacheAside(key, fetchFn, CACHE_TTL.SEARCH);
}

/**
 * Update cache hit ratio metrics
 * Call this periodically to update the gauge
 */
export async function updateCacheMetrics() {
  try {
    const info = await redisClient.info('stats');
    const hitMatch = info.match(/keyspace_hits:(\d+)/);
    const missMatch = info.match(/keyspace_misses:(\d+)/);

    if (hitMatch && missMatch) {
      const hits = parseInt(hitMatch[1]);
      const misses = parseInt(missMatch[1]);
      const total = hits + misses;
      if (total > 0) {
        metrics.cacheHitRatio.set({ cache_type: 'overall' }, hits / total);
      }
    }
  } catch (error) {
    console.error('Failed to update cache metrics:', error);
  }
}

export default {
  cacheGet,
  cacheSet,
  cacheDel,
  cacheDelPattern,
  cacheAside,
  getCachedListing,
  invalidateListingCache,
  getCachedAvailability,
  invalidateAvailabilityCache,
  getCachedSearchResults,
  updateCacheMetrics,
  CACHE_TTL,
  CACHE_PREFIX,
};
