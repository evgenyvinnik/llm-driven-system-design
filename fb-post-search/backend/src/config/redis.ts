import Redis from 'ioredis';
import { config } from '../config/index.js';

export const redis = new Redis(config.redis.url);

redis.on('error', (err) => {
  console.error('Redis connection error:', err);
});

redis.on('connect', () => {
  console.log('Connected to Redis');
});

// Cache helpers
export async function getCache<T>(key: string): Promise<T | null> {
  const value = await redis.get(key);
  if (!value) return null;
  try {
    return JSON.parse(value) as T;
  } catch {
    return value as unknown as T;
  }
}

export async function setCache(
  key: string,
  value: unknown,
  ttlSeconds?: number
): Promise<void> {
  const serialized = typeof value === 'string' ? value : JSON.stringify(value);
  if (ttlSeconds) {
    await redis.setex(key, ttlSeconds, serialized);
  } else {
    await redis.set(key, serialized);
  }
}

export async function deleteCache(key: string): Promise<void> {
  await redis.del(key);
}

// Visibility cache keys
export const cacheKeys = {
  userVisibility: (userId: string) => `visibility:${userId}`,
  searchSuggestions: (prefix: string) => `suggestions:${prefix}`,
  userSession: (sessionId: string) => `session:${sessionId}`,
  trendingSearches: () => 'trending:searches',
};
