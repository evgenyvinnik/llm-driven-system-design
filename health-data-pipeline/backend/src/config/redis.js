import Redis from 'ioredis';
import { config } from './index.js';

export const redis = new Redis(config.redis.url);

redis.on('error', (err) => {
  console.error('Redis connection error:', err);
});

redis.on('connect', () => {
  console.log('Redis connected');
});

// Cache helpers
export const cache = {
  get: async (key) => {
    const value = await redis.get(key);
    return value ? JSON.parse(value) : null;
  },

  set: async (key, value, ttlSeconds = 300) => {
    await redis.setex(key, ttlSeconds, JSON.stringify(value));
  },

  del: async (key) => {
    await redis.del(key);
  },

  // Cache pattern for user data
  getUserCacheKey: (userId, type) => `user:${userId}:${type}`,

  // Invalidate all user cache
  invalidateUser: async (userId) => {
    const keys = await redis.keys(`user:${userId}:*`);
    if (keys.length > 0) {
      await redis.del(...keys);
    }
  }
};
