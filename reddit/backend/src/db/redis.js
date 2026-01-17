import Redis from 'ioredis';
import dotenv from 'dotenv';
import logger from '../shared/logger.js';
import { cacheHits, cacheMisses } from '../shared/metrics.js';

dotenv.config();

const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379', {
  maxRetriesPerRequest: 3,
  retryStrategy(times) {
    const delay = Math.min(times * 50, 2000);
    return delay;
  },
  lazyConnect: false,
});

redis.on('error', (err) => {
  logger.error({ err }, 'Redis connection error');
});

redis.on('connect', () => {
  logger.info('Connected to Redis');
});

redis.on('ready', () => {
  logger.info('Redis connection ready');
});

redis.on('reconnecting', () => {
  logger.warn('Redis reconnecting');
});

redis.on('close', () => {
  logger.warn('Redis connection closed');
});

/**
 * Get a value from cache with metrics tracking.
 */
export const cacheGet = async (key, cacheType = 'default') => {
  const value = await redis.get(key);
  if (value !== null) {
    cacheHits.inc({ cache_type: cacheType });
  } else {
    cacheMisses.inc({ cache_type: cacheType });
  }
  return value;
};

/**
 * Set a value in cache with TTL.
 */
export const cacheSet = async (key, value, ttlSeconds) => {
  if (ttlSeconds) {
    await redis.setex(key, ttlSeconds, value);
  } else {
    await redis.set(key, value);
  }
};

export default redis;
