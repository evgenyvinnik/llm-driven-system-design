import Redis from 'ioredis';
import { indexLogger } from './logger.js';

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';

export const redis = new Redis(REDIS_URL, {
  maxRetriesPerRequest: 3,
  retryDelayOnFailover: 100,
  lazyConnect: true,
});

redis.on('connect', () => {
  indexLogger.info('Connected to Redis');
});

redis.on('error', (err) => {
  indexLogger.error({ error: err.message }, 'Redis connection error');
});

redis.on('close', () => {
  indexLogger.warn('Redis connection closed');
});

/**
 * Get a value from Redis cache
 * @param {string} key - Cache key
 * @returns {Promise<any|null>} - Cached value or null
 */
export async function cacheGet(key) {
  try {
    const value = await redis.get(key);
    return value ? JSON.parse(value) : null;
  } catch (err) {
    indexLogger.error({ key, error: err.message }, 'Cache get error');
    return null;
  }
}

/**
 * Set a value in Redis cache with optional TTL
 * @param {string} key - Cache key
 * @param {any} value - Value to cache
 * @param {number} ttlSeconds - TTL in seconds (default: 1 hour)
 * @returns {Promise<boolean>} - Success status
 */
export async function cacheSet(key, value, ttlSeconds = 3600) {
  try {
    await redis.setex(key, ttlSeconds, JSON.stringify(value));
    return true;
  } catch (err) {
    indexLogger.error({ key, error: err.message }, 'Cache set error');
    return false;
  }
}

/**
 * Delete a key from Redis cache
 * @param {string} key - Cache key
 * @returns {Promise<boolean>} - Success status
 */
export async function cacheDel(key) {
  try {
    await redis.del(key);
    return true;
  } catch (err) {
    indexLogger.error({ key, error: err.message }, 'Cache delete error');
    return false;
  }
}

/**
 * Check if Redis is connected
 * @returns {Promise<boolean>} - Connection status
 */
export async function isRedisConnected() {
  try {
    await redis.ping();
    return true;
  } catch {
    return false;
  }
}

/**
 * Gracefully close Redis connection
 */
export async function closeRedis() {
  try {
    await redis.quit();
    indexLogger.info('Redis connection closed gracefully');
  } catch (err) {
    indexLogger.error({ error: err.message }, 'Error closing Redis connection');
  }
}

export default redis;
