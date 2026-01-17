/**
 * Redis client configuration and instances.
 *
 * Three separate Redis clients are maintained:
 * - `redis`: General operations (canvas state, cooldowns)
 * - `redisSub`: Pub/sub subscriber for receiving pixel updates
 * - `redisPub`: Pub/sub publisher for broadcasting pixel updates
 *
 * Separate clients are required because Redis connections in subscribe mode
 * cannot be used for other commands.
 */
import Redis from 'ioredis';

/**
 * Primary Redis client for general operations.
 * Used for canvas state storage, cooldown management, and other key-value operations.
 */
export const redis = new Redis({
  host: process.env.REDIS_HOST || 'localhost',
  port: parseInt(process.env.REDIS_PORT || '6379'),
  retryStrategy: (times) => {
    const delay = Math.min(times * 50, 2000);
    return delay;
  },
});

/**
 * Redis client dedicated to pub/sub subscriptions.
 * Listens for pixel update events from other server instances.
 */
export const redisSub = new Redis({
  host: process.env.REDIS_HOST || 'localhost',
  port: parseInt(process.env.REDIS_PORT || '6379'),
  retryStrategy: (times) => {
    const delay = Math.min(times * 50, 2000);
    return delay;
  },
});

/**
 * Redis client dedicated to pub/sub publishing.
 * Broadcasts pixel update events to all server instances.
 */
export const redisPub = new Redis({
  host: process.env.REDIS_HOST || 'localhost',
  port: parseInt(process.env.REDIS_PORT || '6379'),
  retryStrategy: (times) => {
    const delay = Math.min(times * 50, 2000);
    return delay;
  },
});

redis.on('error', (err) => console.error('Redis Client Error:', err));
redis.on('connect', () => console.log('Redis Client Connected'));

redisSub.on('error', (err) => console.error('Redis Subscriber Error:', err));
redisPub.on('error', (err) => console.error('Redis Publisher Error:', err));
