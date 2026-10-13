/**
 * Redis client module for the job scheduler.
 * Provides the shared connection for coordination state that can be rebuilt if lost:
 * the scheduler leader lease, sessions and users, idempotency records, and the worker
 * liveness registry. Executions are not queued here; they live in PostgreSQL.
 * @module queue/redis
 */

import Redis from 'ioredis';
import { logger } from '../utils/logger';

/** Redis connection URL from environment, defaults to localhost */
const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';

/**
 * Shared Redis client instance.
 * Configured with retry strategy and connection monitoring.
 */
export const redis = new Redis(redisUrl, {
  maxRetriesPerRequest: 3,
  retryStrategy(times) {
    const delay = Math.min(times * 50, 2000);
    return delay;
  },
});

redis.on('connect', () => {
  logger.info('Connected to Redis');
});

redis.on('error', (error) => {
  logger.error('Redis connection error', error);
});

redis.on('close', () => {
  logger.warn('Redis connection closed');
});

/**
 * Checks if Redis is available and responding.
 * @returns True if Redis responds to PING, false otherwise
 */
export async function healthCheck(): Promise<boolean> {
  try {
    await redis.ping();
    return true;
  } catch {
    return false;
  }
}

/**
 * Gracefully disconnects from Redis.
 * Should be called during application shutdown.
 */
export async function disconnect(): Promise<void> {
  await redis.quit();
}
