import { Redis } from 'ioredis';
import { config } from './index.js';

export const redis: Redis = new Redis(config.redis.url);

redis.on('error', (err: Error) => {
  console.error('Redis connection error:', err);
});

redis.on('connect', () => {
  console.log('Redis connected');
});

export interface CacheHelpers {
  get: <T = unknown>(key: string) => Promise<T | null>;
  set: (key: string, value: unknown, ttlSeconds?: number) => Promise<void>;
  del: (key: string) => Promise<void>;
  getUserCacheKey: (userId: string, type: string) => string;
  invalidateUser: (userId: string) => Promise<void>;
}

// Cache helpers
export const cache: CacheHelpers = {
  get: async <T = unknown>(key: string): Promise<T | null> => {
    const value = await redis.get(key);
    return value ? (JSON.parse(value) as T) : null;
  },

  set: async (key: string, value: unknown, ttlSeconds: number = 300): Promise<void> => {
    await redis.setex(key, ttlSeconds, JSON.stringify(value));
  },

  del: async (key: string): Promise<void> => {
    await redis.del(key);
  },

  // Cache pattern for user data
  getUserCacheKey: (userId: string, type: string): string => `user:${userId}:${type}`,

  // Invalidate all user cache
  invalidateUser: async (userId: string): Promise<void> => {
    const keys = await redis.keys(`user:${userId}:*`);
    if (keys.length > 0) {
      await redis.del(...keys);
    }
  }
};
