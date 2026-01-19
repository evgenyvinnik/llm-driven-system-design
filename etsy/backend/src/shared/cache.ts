import redis from '../services/redis.js';
import { cacheHits, cacheMisses, cacheInvalidations } from './metrics.js';
import { cacheLogger as logger } from './logger.js';

// Cache TTL configuration (in seconds)
export const CACHE_TTL: Record<string, number> = {
  PRODUCT: 300,           // 5 minutes - products change rarely
  SHOP: 600,              // 10 minutes - shop info stable
  SHOP_PRODUCTS: 180,     // 3 minutes - product list for a shop
  SEARCH: 120,            // 2 minutes - balance freshness with ES load
  TRENDING: 900,          // 15 minutes - computed aggregation
  CATEGORY: 3600,         // 1 hour - categories rarely change
  INVENTORY: 30,          // 30 seconds - critical for "only 1 left" accuracy
};

// Cache key prefixes
export const CACHE_KEYS: Record<string, string> = {
  PRODUCT: 'product:',
  SHOP: 'shop:',
  SHOP_PRODUCTS: 'shop:products:',
  SEARCH: 'search:',
  TRENDING: 'trending:',
  CATEGORY: 'category:',
  LOCK: 'lock:',
  IDEMPOTENCY: 'idempotency:',
  CART: 'cart:',
};

/**
 * Get data from cache with metrics tracking
 * @param key - Cache key
 * @param cacheType - Type for metrics (product, shop, search)
 * @returns Parsed cached data or null
 */
export async function getFromCache<T>(key: string, cacheType: string = 'generic'): Promise<T | null> {
  try {
    const cached = await redis.get(key);
    if (cached) {
      cacheHits.labels(cacheType).inc();
      logger.debug({ key, cacheType }, 'Cache hit');
      return JSON.parse(cached) as T;
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
 * @param key - Cache key
 * @param data - Data to cache (will be JSON stringified)
 * @param ttl - TTL in seconds
 * @returns Success status
 */
export async function setInCache(key: string, data: unknown, ttl: number): Promise<boolean> {
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
 * @param key - Cache key
 * @param fetchFn - Async function to fetch data on cache miss
 * @param ttl - TTL in seconds
 * @param cacheType - Type for metrics
 * @returns Data from cache or source
 */
export async function cacheAside<T>(
  key: string,
  fetchFn: () => Promise<T>,
  ttl: number,
  cacheType: string = 'generic'
): Promise<T> {
  // Try cache first
  const cached = await getFromCache<T>(key, cacheType);
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
 * @param key - Cache key
 * @param fetchFn - Async function to fetch data
 * @param ttl - TTL in seconds
 * @param cacheType - Type for metrics
 * @returns Data from cache or source
 */
export async function cacheAsideWithLock<T>(
  key: string,
  fetchFn: () => Promise<T>,
  ttl: number,
  cacheType: string = 'generic'
): Promise<T> {
  // Try cache first
  const cached = await getFromCache<T>(key, cacheType);
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
    const rechecked = await getFromCache<T>(key, cacheType);
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
 * @param key - Cache key to invalidate
 * @param cacheType - Type for metrics
 * @param reason - Reason for invalidation
 */
export async function invalidateCache(key: string, cacheType: string = 'generic', reason: string = 'update'): Promise<void> {
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
 * @param pattern - Pattern to match (e.g., "shop:123:*")
 * @param cacheType - Type for metrics
 * @param reason - Reason for invalidation
 */
export async function invalidateCachePattern(pattern: string, cacheType: string = 'generic', reason: string = 'update'): Promise<void> {
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
 * @param productId - Product ID
 * @param fetchFn - Function to fetch product from DB
 * @returns Product data
 */
export async function getCachedProduct<T>(productId: number, fetchFn: () => Promise<T>): Promise<T> {
  const key = `${CACHE_KEYS.PRODUCT}${productId}`;
  return cacheAsideWithLock(key, fetchFn, CACHE_TTL.PRODUCT, 'product');
}

/**
 * Get shop from cache or database
 * @param shopIdOrSlug - Shop ID or slug
 * @param fetchFn - Function to fetch shop from DB
 * @returns Shop data
 */
export async function getCachedShop<T>(shopIdOrSlug: number | string, fetchFn: () => Promise<T>): Promise<T> {
  const key = `${CACHE_KEYS.SHOP}${shopIdOrSlug}`;
  return cacheAsideWithLock(key, fetchFn, CACHE_TTL.SHOP, 'shop');
}

/**
 * Invalidate product cache and related caches
 * @param productId - Product ID
 * @param shopId - Shop ID (for invalidating shop product list)
 * @param categoryId - Category ID (for invalidating category searches)
 */
export async function invalidateProductCache(productId: number, shopId: number, categoryId: number | null): Promise<void> {
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
 * @param shopId - Shop ID
 * @param slug - Shop slug (if available)
 */
export async function invalidateShopCache(shopId: number, slug?: string): Promise<void> {
  await invalidateCache(`${CACHE_KEYS.SHOP}${shopId}`, 'shop', 'update');
  if (slug) {
    await invalidateCache(`${CACHE_KEYS.SHOP}${slug}`, 'shop', 'update');
  }
  await invalidateCache(`${CACHE_KEYS.SHOP_PRODUCTS}${shopId}`, 'shop', 'update');
}

// Helper function
function sleep(ms: number): Promise<void> {
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
