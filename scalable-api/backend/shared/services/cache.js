import Redis from 'ioredis';
import config from '../config/index.js';

let redisClient = null;

export function getRedisClient() {
  if (!redisClient) {
    redisClient = new Redis({
      host: config.redis.host,
      port: config.redis.port,
      retryDelayOnFailover: 100,
      maxRetriesPerRequest: 3,
      enableReadyCheck: true,
      lazyConnect: true,
    });

    redisClient.on('error', (err) => {
      console.error('Redis connection error:', err.message);
    });

    redisClient.on('connect', () => {
      console.log('Connected to Redis');
    });
  }
  return redisClient;
}

/**
 * Cache service with multi-level caching (local + Redis)
 */
export class CacheService {
  constructor(redis = null) {
    this.redis = redis || getRedisClient();
    this.localCache = new Map();
    this.localCacheTTL = config.cache.localTtl;
    this.defaultTTL = config.cache.ttl;
    this.stats = {
      localHits: 0,
      redisHits: 0,
      misses: 0,
    };
  }

  /**
   * Get value from cache (local first, then Redis)
   */
  async get(key) {
    // Level 1: Local in-memory cache
    const local = this.localCache.get(key);
    if (local && local.expiry > Date.now()) {
      this.stats.localHits++;
      return local.value;
    }

    // Level 2: Redis cache
    try {
      const cached = await this.redis.get(key);
      if (cached) {
        const parsed = JSON.parse(cached);
        // Populate local cache
        this.localCache.set(key, {
          value: parsed,
          expiry: Date.now() + this.localCacheTTL,
        });
        this.stats.redisHits++;
        return parsed;
      }
    } catch (error) {
      console.error('Redis get error:', error.message);
    }

    this.stats.misses++;
    return null;
  }

  /**
   * Set value in cache
   */
  async set(key, value, ttlSeconds = null) {
    const ttl = ttlSeconds || this.defaultTTL;

    try {
      // Set in Redis
      await this.redis.setex(key, ttl, JSON.stringify(value));
    } catch (error) {
      console.error('Redis set error:', error.message);
    }

    // Set in local cache
    this.localCache.set(key, {
      value,
      expiry: Date.now() + Math.min(ttl * 1000, this.localCacheTTL),
    });
  }

  /**
   * Delete key from cache
   */
  async delete(key) {
    this.localCache.delete(key);
    try {
      await this.redis.del(key);
    } catch (error) {
      console.error('Redis del error:', error.message);
    }
  }

  /**
   * Invalidate keys matching pattern
   */
  async invalidate(pattern) {
    // Clear local cache entries matching pattern
    const regex = new RegExp(pattern.replace(/\*/g, '.*'));
    for (const key of this.localCache.keys()) {
      if (regex.test(key)) {
        this.localCache.delete(key);
      }
    }

    // Invalidate Redis keys
    try {
      const keys = await this.redis.keys(pattern);
      if (keys.length > 0) {
        await this.redis.del(...keys);
      }
    } catch (error) {
      console.error('Redis invalidate error:', error.message);
    }
  }

  /**
   * Cache-aside pattern: get from cache or fetch and cache
   */
  async getOrFetch(key, fetchFn, ttl = null) {
    const cached = await this.get(key);
    if (cached !== null) {
      return cached;
    }

    const value = await fetchFn();
    await this.set(key, value, ttl);
    return value;
  }

  /**
   * Get cache statistics
   */
  getStats() {
    return {
      ...this.stats,
      localCacheSize: this.localCache.size,
      hitRate: this.stats.localHits + this.stats.redisHits > 0
        ? ((this.stats.localHits + this.stats.redisHits) /
            (this.stats.localHits + this.stats.redisHits + this.stats.misses)) * 100
        : 0,
    };
  }

  /**
   * Clear all caches
   */
  async clear() {
    this.localCache.clear();
    try {
      await this.redis.flushdb();
    } catch (error) {
      console.error('Redis clear error:', error.message);
    }
  }
}

export default CacheService;
