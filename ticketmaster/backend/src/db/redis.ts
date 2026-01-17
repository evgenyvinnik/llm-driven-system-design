/**
 * Redis client configuration for the Ticketmaster backend.
 * Redis is used for session storage, distributed locks, seat reservation holds,
 * and the virtual waiting room queue management.
 */
import Redis from 'ioredis';

/**
 * Redis client instance configured with exponential backoff retry strategy.
 * The connection is shared across the application for efficient resource usage.
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
