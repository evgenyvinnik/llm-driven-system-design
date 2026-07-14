import { Redis } from 'ioredis';
import config from '../config/index.js';
import { logger } from './logger.js';

const redis = new Redis({
  host: config.redis.host,
  port: config.redis.port,
  maxRetriesPerRequest: 3,
  retryStrategy(times) {
    const delay = Math.min(times * 200, 3000);
    return delay;
  },
  lazyConnect: true,
});

redis.on('connect', () => {
  logger.info('Redis connected');
});

redis.on('error', (err) => {
  logger.error({ err }, 'Redis error');
});

/** Retrieves a JSON-parsed value from Redis cache by key. */
export async function cacheGet<T>(key: string): Promise<T | null> {
  try {
    const value = await redis.get(key);
    if (value) {
      return JSON.parse(value) as T;
    }
    return null;
  } catch (err) {
    logger.error({ err, key }, 'Cache get error');
    return null;
  }
}

/** Stores a JSON-serialized value in Redis cache with configurable TTL. */
export async function cacheSet(key: string, value: unknown, ttlSeconds = 60): Promise<void> {
  try {
    await redis.set(key, JSON.stringify(value), 'EX', ttlSeconds);
  } catch (err) {
    logger.error({ err, key }, 'Cache set error');
  }
}

/** Deletes a key from Redis cache to invalidate stale data. */
export async function cacheDel(key: string): Promise<void> {
  try {
    await redis.del(key);
  } catch (err) {
    logger.error({ err, key }, 'Cache delete error');
  }
}

export default redis;
