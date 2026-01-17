import Redis from 'ioredis';
import { REDIS_CONFIG, CACHE_CONFIG } from '../config.js';

/**
 * Redis client instance for caching operations.
 * Provides connection pooling and automatic retry on connection failures.
 * Used as a shared cache across all server instances.
 */
export const redis = new Redis({
  host: REDIS_CONFIG.host,
  port: REDIS_CONFIG.port,
  retryStrategy: (times) => {
    const delay = Math.min(times * 50, 2000);
    return delay;
  },
  maxRetriesPerRequest: 3,
});

redis.on('connect', () => {
  console.log('Redis connected');
});

redis.on('error', (error) => {
  console.error('Redis error:', error);
});

/**
 * Cache operations for URL short code to long URL mappings.
 * Provides fast O(1) lookups for the redirect service, avoiding database queries
 * for frequently accessed URLs.
 */
export const urlCache = {
  /**
   * Retrieves the long URL for a short code from cache.
   * @param shortCode - The short code to look up
   * @returns Promise resolving to the long URL or null if not cached
   */
  async get(shortCode: string): Promise<string | null> {
    return redis.get(`url:${shortCode}`);
  },

  /**
   * Caches a short code to long URL mapping with TTL.
   * @param shortCode - The short code as cache key
   * @param longUrl - The destination URL to cache
   * @param ttl - Optional TTL in seconds, defaults to CACHE_CONFIG.urlTTL
   */
  async set(shortCode: string, longUrl: string, ttl?: number): Promise<void> {
    await redis.setex(`url:${shortCode}`, ttl || CACHE_CONFIG.urlTTL, longUrl);
  },

  /**
   * Removes a URL mapping from cache (e.g., when deactivated).
   * @param shortCode - The short code to remove from cache
   */
  async delete(shortCode: string): Promise<void> {
    await redis.del(`url:${shortCode}`);
  },

  /**
   * Checks if a short code exists in cache.
   * @param shortCode - The short code to check
   * @returns Promise resolving to true if cached, false otherwise
   */
  async exists(shortCode: string): Promise<boolean> {
    const result = await redis.exists(`url:${shortCode}`);
    return result === 1;
  },
};

/**
 * Session cache operations for user authentication.
 * Stores session tokens mapped to user IDs for fast authentication lookups.
 */
export const sessionCache = {
  async get(token: string): Promise<string | null> {
    return redis.get(`session:${token}`);
  },

  async set(token: string, userId: string, ttl?: number): Promise<void> {
    await redis.setex(`session:${token}`, ttl || CACHE_CONFIG.sessionTTL, userId);
  },

  async delete(token: string): Promise<void> {
    await redis.del(`session:${token}`);
  },
};

/**
 * Key pool cache for local server key allocation.
 * Manages pre-generated short codes allocated to this server instance
 * to enable horizontal scaling without key collisions.
 */
export const keyPoolCache = {
  async getKeys(): Promise<string[]> {
    return redis.lrange('local_key_pool', 0, -1);
  },

  async popKey(): Promise<string | null> {
    return redis.lpop('local_key_pool');
  },

  async addKeys(keys: string[]): Promise<void> {
    if (keys.length > 0) {
      await redis.rpush('local_key_pool', ...keys);
    }
  },

  async count(): Promise<number> {
    return redis.llen('local_key_pool');
  },
};

/**
 * Closes the Redis connection during graceful shutdown.
 * @returns Promise that resolves when the connection is closed
 */
export async function closeRedis(): Promise<void> {
  await redis.quit();
  console.log('Redis connection closed');
}
