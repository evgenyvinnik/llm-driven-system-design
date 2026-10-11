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

/**
 * Establishes the Redis connection (used on startup). A lazy client connects on its first
 * command, and the rate-limit store sends one at import time, so the connection may
 * already be under way; in that case wait for it instead of calling connect() twice.
 */
export async function connectRedis(timeoutMs = 5000): Promise<void> {
  try {
    if (redis.status === 'wait') {
      await redis.connect();
      return;
    }
    if (redis.status === 'ready') return;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Redis not ready')), timeoutMs);
      redis.once('ready', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  } catch (err) {
    logger.error({ err }, 'Failed to connect to Redis');
  }
}
