import { Redis } from 'ioredis';
import { config } from './config.js';

/**
 * Redis client instance for the trading platform.
 * Used for caching stock quotes, session storage, pub/sub for real-time
 * quote distribution, and storing triggered price alerts.
 * Includes automatic retry logic with exponential backoff.
 */
export const redis = new Redis({
  host: config.redis.host,
  port: config.redis.port,
  retryStrategy(times) {
    const delay = Math.min(times * 50, 2000);
    return delay;
  },
});

redis.on('error', (err) => {
  console.error('Redis error:', err);
});

redis.on('connect', () => {
  console.log('Connected to Redis');
});

/**
 * Tests the Redis connection by sending a PING command.
 * Used during server startup to verify Redis availability
 * and for health check endpoints.
 * @returns Promise resolving to true if connection succeeds, false otherwise
 */
export async function testRedisConnection(): Promise<boolean> {
  try {
    await redis.ping();
    return true;
  } catch (error) {
    console.error('Redis connection failed:', error);
    return false;
  }
}
