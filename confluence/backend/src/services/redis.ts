import { Redis } from 'ioredis';
import { config } from '../config/index.js';
import { logger } from './logger.js';

/** Redis client instance with retry strategy and error logging. */
export const redis = new Redis({
  host: config.redis.host,
  port: config.redis.port,
  maxRetriesPerRequest: 3,
  retryStrategy(times: number) {
    const delay = Math.min(times * 200, 5000);
    return delay;
  },
});

redis.on('error', (err) => {
  logger.error({ err }, 'Redis connection error');
});

redis.on('connect', () => {
  logger.debug('Connected to Redis');
});

/** Retrieves and deserializes a cached value by key, returning null on miss. */
export async function cacheGet<T>(key: string): Promise<T | null> {
  const data = await redis.get(key);
  if (!data) return null;
  return JSON.parse(data) as T;
}

/** Serializes and stores a value in Redis with a TTL in seconds. */
export async function cacheSet(key: string, value: unknown, ttlSeconds = 300): Promise<void> {
  await redis.set(key, JSON.stringify(value), 'EX', ttlSeconds);
}

/** Deletes a single cache entry by exact key. */
export async function cacheDel(key: string): Promise<void> {
  await redis.del(key);
}

/** Deletes all cache entries matching a glob pattern (e.g., "space:*"). */
export async function cacheDelPattern(pattern: string): Promise<void> {
  const keys = await redis.keys(pattern);
  if (keys.length > 0) {
    await redis.del(...keys);
  }
}
