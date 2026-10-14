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
 * A second connection just for rate-limit counters. With the offline queue off, its
 * commands fail at once while Redis is unreachable, so a limiter that fails open does
 * so immediately. On the shared client every request would first wait out the
 * reconnect retries (about two seconds per request during an outage).
 */
export const rateLimitRedis = new Redis(config.redis.url, {
  enableOfflineQueue: false,
  maxRetriesPerRequest: 1,
  retryStrategy(times: number) {
    return Math.min(times * 200, 2000);
  },
  lazyConnect: true,
});

// The main client already logs connection errors; this one would only repeat them.
rateLimitRedis.on('error', (err: Error) => {
  logger.debug({ err }, 'Rate-limit Redis connection error');
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
