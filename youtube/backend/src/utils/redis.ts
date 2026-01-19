import Redis from 'ioredis';
import type { Redis as RedisType } from 'ioredis';
import config from '../config/index.js';

// ============ Type Definitions ============

export interface SessionData {
  id: string;
  username: string;
  email: string;
  channelName: string;
  role: string;
  avatarUrl?: string;
  createdAt: string;
}

// ============ Redis Client Setup ============

// Handle ESM/CJS interop for ioredis
const RedisClient = (Redis as unknown as { default: typeof Redis }).default || Redis;

const redis: RedisType = new RedisClient({
  host: config.redis.host,
  port: config.redis.port,
  retryStrategy: (times: number): number => {
    const delay = Math.min(times * 50, 2000);
    return delay;
  },
  maxRetriesPerRequest: 3,
});

redis.on('error', (err: Error) => {
  console.error('Redis connection error:', err.message);
});

redis.on('connect', () => {
  console.log('Connected to Redis');
});

// ============ Cache Helpers ============

export const cacheGet = async <T = unknown>(key: string): Promise<T | null> => {
  const value = await redis.get(key);
  return value ? (JSON.parse(value) as T) : null;
};

export const cacheSet = async <T = unknown>(
  key: string,
  value: T,
  ttlSeconds: number = 300
): Promise<void> => {
  await redis.setex(key, ttlSeconds, JSON.stringify(value));
};

export const cacheDelete = async (key: string): Promise<void> => {
  await redis.del(key);
};

// ============ Session Helpers ============

export const sessionGet = async (sessionId: string): Promise<SessionData | null> => {
  return cacheGet<SessionData>(`session:${sessionId}`);
};

export const sessionSet = async (
  sessionId: string,
  userData: SessionData,
  ttlSeconds: number = 7 * 24 * 60 * 60
): Promise<void> => {
  await cacheSet(`session:${sessionId}`, userData, ttlSeconds);
};

export const sessionDelete = async (sessionId: string): Promise<void> => {
  await cacheDelete(`session:${sessionId}`);
};

// ============ View Count Buffering ============

export const incrementViewCount = async (videoId: string): Promise<void> => {
  await redis.incr(`views:${videoId}`);
};

export const getBufferedViewCount = async (videoId: string): Promise<number> => {
  const count = await redis.get(`views:${videoId}`);
  return parseInt(count || '0', 10);
};

export const flushViewCounts = async (): Promise<Record<string, number>> => {
  const keys = await redis.keys('views:*');
  const counts: Record<string, number> = {};

  for (const key of keys) {
    const videoId = key.split(':')[1];
    if (videoId) {
      const count = await redis.getset(key, '0');
      if (count && parseInt(count, 10) > 0) {
        counts[videoId] = parseInt(count, 10);
      }
    }
  }

  return counts;
};

// ============ Trending Videos ============

export const updateTrendingScore = async (videoId: string, score: number): Promise<void> => {
  await redis.zadd('trending:global', score, videoId);
  // Keep only top 100
  await redis.zremrangebyrank('trending:global', 0, -101);
};

export const getTrendingVideos = async (limit: number = 50): Promise<string[]> => {
  return redis.zrevrange('trending:global', 0, limit - 1);
};

export default redis;
