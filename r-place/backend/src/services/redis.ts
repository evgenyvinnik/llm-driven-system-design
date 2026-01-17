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
import Redis, { RedisOptions } from 'ioredis';
import { logger } from '../shared/logger.js';

/**
 * Redis connection options with retry strategy.
 */
const redisOptions: RedisOptions = {
  host: process.env.REDIS_HOST || 'localhost',
  port: parseInt(process.env.REDIS_PORT || '6379'),
  retryStrategy: (times: number) => {
    const delay = Math.min(times * 50, 2000);
    logger.warn({ attempt: times, delayMs: delay }, 'Redis connection retry');
    return delay;
  },
  maxRetriesPerRequest: 3,
  enableReadyCheck: true,
  lazyConnect: false,
};

/**
 * Primary Redis client for general operations.
 * Used for canvas state storage, cooldown management, and other key-value operations.
 */
export const redis = new Redis(redisOptions);

/**
 * Redis client dedicated to pub/sub subscriptions.
 * Listens for pixel update events from other server instances.
 */
export const redisSub = new Redis(redisOptions);

/**
 * Redis client dedicated to pub/sub publishing.
 * Broadcasts pixel update events to all server instances.
 */
export const redisPub = new Redis(redisOptions);

// Set up event handlers for main Redis client
redis.on('error', (err) => {
  logger.error({ error: err, client: 'main' }, 'Redis Client Error');
});

redis.on('connect', () => {
  logger.info({ client: 'main' }, 'Redis Client Connected');
});

redis.on('ready', () => {
  logger.info({ client: 'main' }, 'Redis Client Ready');
});

redis.on('close', () => {
  logger.warn({ client: 'main' }, 'Redis Client Connection Closed');
});

redis.on('reconnecting', (delay: number) => {
  logger.info({ client: 'main', delayMs: delay }, 'Redis Client Reconnecting');
});

// Set up event handlers for subscriber client
redisSub.on('error', (err) => {
  logger.error({ error: err, client: 'subscriber' }, 'Redis Subscriber Error');
});

redisSub.on('connect', () => {
  logger.info({ client: 'subscriber' }, 'Redis Subscriber Connected');
});

redisSub.on('ready', () => {
  logger.info({ client: 'subscriber' }, 'Redis Subscriber Ready');
});

// Set up event handlers for publisher client
redisPub.on('error', (err) => {
  logger.error({ error: err, client: 'publisher' }, 'Redis Publisher Error');
});

redisPub.on('connect', () => {
  logger.info({ client: 'publisher' }, 'Redis Publisher Connected');
});

redisPub.on('ready', () => {
  logger.info({ client: 'publisher' }, 'Redis Publisher Ready');
});

/**
 * Checks if the Redis connection is healthy.
 *
 * @returns Promise that resolves to true if Redis is connected, false otherwise.
 */
export async function isRedisHealthy(): Promise<boolean> {
  try {
    await redis.ping();
    return true;
  } catch {
    return false;
  }
}

/**
 * Gracefully closes all Redis connections.
 */
export async function closeRedisConnections(): Promise<void> {
  await Promise.all([
    redis.quit().catch((err) => logger.error({ error: err }, 'Error closing main Redis')),
    redisSub.quit().catch((err) => logger.error({ error: err }, 'Error closing Redis subscriber')),
    redisPub.quit().catch((err) => logger.error({ error: err }, 'Error closing Redis publisher')),
  ]);
  logger.info('All Redis connections closed');
}
