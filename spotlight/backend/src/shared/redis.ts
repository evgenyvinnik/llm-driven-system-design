import Redis from 'ioredis';
import { indexLogger } from './logger.js';

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';

export const redis = new Redis(REDIS_URL, {
  maxRetriesPerRequest: 3,
  lazyConnect: true,
});

redis.on('connect', () => {
  indexLogger.info('Connected to Redis');
});

redis.on('error', (err: Error) => {
  indexLogger.error({ error: err.message }, 'Redis connection error');
});

redis.on('close', () => {
  indexLogger.warn('Redis connection closed');
});

/**
 * Get a value from Redis cache
 */
export async function cacheGet<T = unknown>(key: string): Promise<T | null> {
  try {
    const value = await redis.get(key);
    return value ? (JSON.parse(value) as T) : null;
  } catch (err) {
    const error = err as Error;
    indexLogger.error({ key, error: error.message }, 'Cache get error');
    return null;
  }
}

/**
 * Set a value in Redis cache with optional TTL
 */
export async function cacheSet(key: string, value: unknown, ttlSeconds: number = 3600): Promise<boolean> {
  try {
    await redis.setex(key, ttlSeconds, JSON.stringify(value));
    return true;
  } catch (err) {
    const error = err as Error;
    indexLogger.error({ key, error: error.message }, 'Cache set error');
    return false;
  }
}

/**
 * Delete a key from Redis cache
 */
export async function cacheDel(key: string): Promise<boolean> {
  try {
    await redis.del(key);
    return true;
  } catch (err) {
    const error = err as Error;
    indexLogger.error({ key, error: error.message }, 'Cache delete error');
    return false;
  }
}

/**
 * Check if Redis is connected
 */
export async function isRedisConnected(): Promise<boolean> {
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
export async function closeRedis(): Promise<void> {
  try {
    await redis.quit();
    indexLogger.info('Redis connection closed gracefully');
  } catch (err) {
    const error = err as Error;
    indexLogger.error({ error: error.message }, 'Error closing Redis connection');
  }
}

export default redis;
