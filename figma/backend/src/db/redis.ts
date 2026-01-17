import Redis from 'ioredis';

/**
 * Primary Redis client for general key-value operations.
 * Used for storing presence state with TTL-based expiration.
 * Connects to Redis server using environment variables or defaults.
 */
const redis = new Redis({
  host: process.env.REDIS_HOST || 'localhost',
  port: parseInt(process.env.REDIS_PORT || '6379'),
  maxRetriesPerRequest: 3,
  retryStrategy: (times: number) => Math.min(times * 100, 3000),
});

redis.on('connect', () => {
  console.log('Redis connected successfully');
});

redis.on('error', (error) => {
  console.error('Redis connection error:', error);
});

// Pub/Sub clients for presence updates
/**
 * Redis publisher client for broadcasting presence updates.
 * Separated from the main client because Redis Pub/Sub requires dedicated connections.
 * Used to notify all server instances when a user's presence changes.
 */
export const redisPub = new Redis({
  host: process.env.REDIS_HOST || 'localhost',
  port: parseInt(process.env.REDIS_PORT || '6379'),
});

/**
 * Redis subscriber client for receiving presence update notifications.
 * Listens to per-file channels to receive real-time presence changes.
 * Enables multi-server presence synchronization.
 */
export const redisSub = new Redis({
  host: process.env.REDIS_HOST || 'localhost',
  port: parseInt(process.env.REDIS_PORT || '6379'),
});

export default redis;
