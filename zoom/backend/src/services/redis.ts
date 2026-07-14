import { Redis } from 'ioredis';
import { config } from '../config/index.js';

/** Redis client for session storage and real-time meeting state. */
export const redis = new Redis({
  host: config.redis.host,
  port: config.redis.port,
  maxRetriesPerRequest: 3,
  retryStrategy(times: number) {
    const delay = Math.min(times * 50, 2000);
    return delay;
  },
});

redis.on('error', (err) => {
  console.error('Redis connection error:', err.message);
});
