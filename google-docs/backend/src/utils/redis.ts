import Redis from 'ioredis';

/**
 * Primary Redis client for session caching and general key-value operations.
 * Used for storing user sessions and document state caching.
 * Includes exponential backoff retry strategy for resilient connections.
 */
const redis = new Redis({
  host: process.env.REDIS_HOST || 'localhost',
  port: parseInt(process.env.REDIS_PORT || '6379'),
  retryStrategy: (times) => {
    const delay = Math.min(times * 50, 2000);
    return delay;
  },
});

/**
 * Logs Redis connection errors without crashing the application.
 * Allows the retry strategy to attempt reconnection.
 */
redis.on('error', (err) => {
  console.error('Redis connection error:', err);
});

/**
 * Logs successful connection to Redis server.
 */
redis.on('connect', () => {
  console.log('Connected to Redis');
});

/**
 * Dedicated Redis client for subscribing to pub/sub channels.
 * Separate from main client because subscribers cannot execute other commands.
 * Used to receive real-time operation and presence updates from other servers.
 */
export const redisSub = new Redis({
  host: process.env.REDIS_HOST || 'localhost',
  port: parseInt(process.env.REDIS_PORT || '6379'),
});

/**
 * Dedicated Redis client for publishing to pub/sub channels.
 * Used to broadcast document operations and presence updates to other servers.
 * Enables horizontal scaling by synchronizing state across multiple instances.
 */
export const redisPub = new Redis({
  host: process.env.REDIS_HOST || 'localhost',
  port: parseInt(process.env.REDIS_PORT || '6379'),
});

/** Default Redis client for general operations (sessions, caching) */
export default redis;
