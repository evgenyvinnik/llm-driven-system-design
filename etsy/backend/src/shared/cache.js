import redis from '../services/redis.js';
import { cacheHits, cacheMisses, cacheInvalidations } from './metrics.js';
import { cacheLogger as logger } from './logger.js';

// Cache TTL configuration (in seconds)
export const CACHE_TTL = {
  PRODUCT: 300,           // 5 minutes - products change rarely
  SHOP: 600,              // 10 minutes - shop info stable
  SHOP_PRODUCTS: 180,     // 3 minutes - product list for a shop
  SEARCH: 120,            // 2 minutes - balance freshness with ES load
  TRENDING: 900,          // 15 minutes - computed aggregation
  CATEGORY: 3600,         // 1 hour - categories rarely change
  INVENTORY: 30,          // 30 seconds - critical for "only 1 left" accuracy
};

// Cache key prefixes
export const CACHE_KEYS = {
  PRODUCT: 'product:',
  SHOP: 'shop:',
  SHOP_PRODUCTS: 'shop:products:',
  SEARCH: 'search:',
  TRENDING: 'trending:',
  CATEGORY: 'category:',
  LOCK: 'lock:',
  IDEMPOTENCY: 'idempotency:',
};

/**
 * Get data from cache with metrics tracking
 * @param {string} key - Cache key
 * @param {string} cacheType - Type for metrics (product, shop, search)
 * @returns {Promise<any|null>} Parsed cached data or null
 */
export async function getFromCache(key, cacheType = 'generic') {
  try {
    const cached = await redis.get(key);
    if (cached) {
      cacheHits.labels(cacheType).inc();
      logger.debug({ key, cacheType }, 'Cache hit');
      return JSON.parse(cached);
    }
    cacheMisses.labels(cacheType).inc();
    logger.debug({ key, cacheType }, 'Cache miss');
    return null;
  } catch (error) {
    logger.error({ error, key }, 'Cache get error');
    cacheMisses.labels(cacheType).inc();
    return null;
  }
}

/**
 * Set data in cache with TTL
 * @param {string} key - Cache key
 * @param {any} data - Data to cache (will be JSON stringified)
 * @param {number} ttl - TTL in seconds
 * @returns {Promise<boolean>} Success status
 */
export async function setInCache(key, data, ttl) {
  try {
    await redis.setex(key, ttl, JSON.stringify(data));
    logger.debug({ key, ttl }, 'Cache set');
    return true;
  } catch (error) {
    logger.error({ error, key }, 'Cache set error');
    return false;
  }
}

/**
 * Cache-aside pattern: Get from cache or fetch from source
 * @param {string} key - Cache key
 * @param {Function} fetchFn - Async function to fetch data on cache miss
 * @param {number} ttl - TTL in seconds
 * @param {string} cacheType - Type for metrics
 * @returns {Promise<any>} Data from cache or source
 */
export async function cacheAside(key, fetchFn, ttl, cacheType = 'generic') {
  // Try cache first
  const cached = await getFromCache(key, cacheType);
  if (cached !== null) {
    return cached;
  }

  // Cache miss: fetch from source
  const data = await fetchFn();

  // Store in cache (don't await to avoid blocking)
  if (data !== null && data !== undefined) {
    setInCache(key, data, ttl).catch((err) => {
      logger.error({ error: err, key }, 'Failed to cache data');
    });
  }

  return data;
}

/**
 * Cache-aside with stampede prevention using locks
 * Prevents multiple concurrent requests from hitting the database
 * @param {string} key - Cache key
 * @param {Function} fetchFn - Async function to fetch data
 * @param {number} ttl - TTL in seconds
 * @param {string} cacheType - Type for metrics
 * @returns {Promise<any>} Data from cache or source
 */
export async function cacheAsideWithLock(key, fetchFn, ttl, cacheType = 'generic') {
  // Try cache first
  const cached = await getFromCache(key, cacheType);
  if (cached !== null) {
    return cached;
  }

  const lockKey = `${CACHE_KEYS.LOCK}${key}`;

  // Try to acquire lock
  const acquired = await redis.set(lockKey, '1', 'EX', 5, 'NX');

  if (!acquired) {
    // Another process is fetching; wait and retry
    logger.debug({ key }, 'Lock not acquired, waiting');
    await sleep(50);
    return cacheAsideWithLock(key, fetchFn, ttl, cacheType);
  }

  try {
    // Double-check cache (another process may have populated it)
    const rechecked = await getFromCache(key, cacheType);
    if (rechecked !== null) {
      return rechecked;
    }

    // Fetch from source
    const data = await fetchFn();

    // Store in cache
    if (data !== null && data !== undefined) {
      await setInCache(key, data, ttl);
    }

    return data;
  } finally {
    // Release lock
    await redis.del(lockKey);
  }
}

/**
 * Invalidate a single cache key
 * @param {string} key - Cache key to invalidate
 * @param {string} cacheType - Type for metrics
 * @param {string} reason - Reason for invalidation
 */
export async function invalidateCache(key, cacheType = 'generic', reason = 'update') {
  try {
    await redis.del(key);
    cacheInvalidations.labels(cacheType, reason).inc();
    logger.info({ key, cacheType, reason }, 'Cache invalidated');
  } catch (error) {
    logger.error({ error, key }, 'Cache invalidation error');
  }
}

/**
 * Invalidate multiple cache keys matching a pattern
 * @param {string} pattern - Pattern to match (e.g., "shop:123:*")
 * @param {string} cacheType - Type for metrics
 * @param {string} reason - Reason for invalidation
 */
export async function invalidateCachePattern(pattern, cacheType = 'generic', reason = 'update') {
  try {
    let cursor = '0';
    let keysDeleted = 0;

    do {
      const [newCursor, keys] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
      cursor = newCursor;

      if (keys.length > 0) {
        await redis.del(...keys);
        keysDeleted += keys.length;
      }
    } while (cursor !== '0');

    if (keysDeleted > 0) {
      cacheInvalidations.labels(cacheType, reason).inc(keysDeleted);
      logger.info({ pattern, keysDeleted, cacheType, reason }, 'Cache pattern invalidated');
    }
  } catch (error) {
    logger.error({ error, pattern }, 'Cache pattern invalidation error');
  }
}

/**
 * Get product from cache or database
 * @param {number} productId - Product ID
 * @param {Function} fetchFn - Function to fetch product from DB
 * @returns {Promise<any>} Product data
 */
export async function getCachedProduct(productId, fetchFn) {
  const key = `${CACHE_KEYS.PRODUCT}${productId}`;
  return cacheAsideWithLock(key, fetchFn, CACHE_TTL.PRODUCT, 'product');
}

/**
 * Get shop from cache or database
 * @param {number|string} shopIdOrSlug - Shop ID or slug
 * @param {Function} fetchFn - Function to fetch shop from DB
 * @returns {Promise<any>} Shop data
 */
export async function getCachedShop(shopIdOrSlug, fetchFn) {
  const key = `${CACHE_KEYS.SHOP}${shopIdOrSlug}`;
  return cacheAsideWithLock(key, fetchFn, CACHE_TTL.SHOP, 'shop');
}

/**
 * Invalidate product cache and related caches
 * @param {number} productId - Product ID
 * @param {number} shopId - Shop ID (for invalidating shop product list)
 * @param {number} categoryId - Category ID (for invalidating category searches)
 */
export async function invalidateProductCache(productId, shopId, categoryId) {
  // Invalidate product cache
  await invalidateCache(`${CACHE_KEYS.PRODUCT}${productId}`, 'product', 'update');

  // Invalidate shop product list cache
  if (shopId) {
    await invalidateCache(`${CACHE_KEYS.SHOP_PRODUCTS}${shopId}`, 'shop', 'product_update');
  }

  // Invalidate related search caches
  if (categoryId) {
    await invalidateCachePattern(`${CACHE_KEYS.SEARCH}category:${categoryId}:*`, 'search', 'product_update');
  }

  // Invalidate trending cache (product changes might affect rankings)
  await invalidateCachePattern(`${CACHE_KEYS.TRENDING}*`, 'trending', 'product_update');
}

/**
 * Invalidate shop cache
 * @param {number} shopId - Shop ID
 * @param {string} slug - Shop slug (if available)
 */
export async function invalidateShopCache(shopId, slug) {
  await invalidateCache(`${CACHE_KEYS.SHOP}${shopId}`, 'shop', 'update');
  if (slug) {
    await invalidateCache(`${CACHE_KEYS.SHOP}${slug}`, 'shop', 'update');
  }
  await invalidateCache(`${CACHE_KEYS.SHOP_PRODUCTS}${shopId}`, 'shop', 'update');
}

// Helper function
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export default {
  getFromCache,
  setInCache,
  cacheAside,
  cacheAsideWithLock,
  invalidateCache,
  invalidateCachePattern,
  getCachedProduct,
  getCachedShop,
  invalidateProductCache,
  invalidateShopCache,
  CACHE_TTL,
  CACHE_KEYS,
};
