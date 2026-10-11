import IORedis from 'ioredis';
import { config } from '../config/index.js';
import { logger } from './logger.js';

const Redis = IORedis.default || IORedis;

/** Redis client instance with retry strategy and lazy connection. */
export const redis = new Redis(config.redis.url, {
  maxRetriesPerRequest: 3,
  retryStrategy(times: number) {
    const delay = Math.min(times * 50, 2000);
    return delay;
  },
  lazyConnect: true,
});

redis.on('error', (err: Error) => {
  logger.error({ err }, 'Redis connection error');
});

redis.on('connect', () => {
  logger.info('Redis connected');
});

/** Establishes the Redis connection (used on startup). */
export async function connectRedis(): Promise<void> {
  // A command issued before startup (the rate limiters load their scripts at import time) has
  // already opened the connection; connecting again would only report "already connecting".
  if (redis.status !== 'wait') return;
  try {
    await redis.connect();
  } catch (err) {
    logger.error({ err }, 'Failed to connect to Redis');
  }
}
