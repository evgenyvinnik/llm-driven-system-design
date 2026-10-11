import { Redis } from 'ioredis';

const redis = new Redis({
  host: process.env.REDIS_HOST || 'localhost',
  port: parseInt(process.env.REDIS_PORT || '6379'),
  // Commands fail fast while disconnected instead of piling up...
  maxRetriesPerRequest: 3,
  // ...but the connection itself is retried forever with capped backoff. Returning null here
  // (as this file used to after 3 attempts) stops reconnecting for good: a two-second Redis
  // restart left every session lookup failing until the API process was restarted.
  retryStrategy: (times: number) => Math.min(times * 200, 5000),
  lazyConnect: true,
});

redis.on('connect', () => {
  console.log('Connected to Redis');
});

redis.on('error', (err: Error) => {
  console.error('Redis connection error:', err.message);
});

/** Redis client with lazy connect and capped exponential reconnect for sessions and caching. */
export default redis;
