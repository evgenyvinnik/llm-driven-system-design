import IORedis from 'ioredis';
import { config } from '../config/index.js';
import { logger } from './logger.js';

const Redis = IORedis.default || IORedis;

/** Redis client instance with retry strategy and lazy connection for session storage. */
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

/** Establishes the Redis connection, logging errors on failure. */
export async function connectRedis(): Promise<void> {
  try {
    // The rate-limit store issues a command at import time, which already
    // starts the lazy connection; connect() would then throw "already connecting".
    if (redis.status === 'wait') {
      await redis.connect();
    }
  } catch (err) {
    logger.error({ err }, 'Failed to connect to Redis');
  }
}
