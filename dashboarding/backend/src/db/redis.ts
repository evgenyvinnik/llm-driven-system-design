/**
 * @fileoverview Redis client configuration and connection management.
 *
 * Creates a Redis client used for caching query results, storing session data,
 * and caching metric definition IDs. The client includes automatic retry logic
 * with exponential backoff for resilience.
 */

import Redis from 'ioredis';

/**
 * Redis client instance for caching and session storage.
 *
 * Used throughout the application for:
 * - Query result caching (reduces database load for repeated queries)
 * - Session storage (via connect-redis middleware)
 * - Metric ID caching (speeds up high-throughput ingestion)
 *
 * Configured with retry strategy using exponential backoff capped at 2 seconds.
 */
const redis = new Redis({
  host: process.env.REDIS_HOST || 'localhost',
  port: parseInt(process.env.REDIS_PORT || '6379'),
  maxRetriesPerRequest: 3,
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

export default redis;
