import Redis from 'ioredis';
import { config } from './index.js';

export const redis = new Redis(config.redis.url);

redis.on('error', (err) => {
  console.error('Redis error:', err);
});

redis.on('connect', () => {
  console.log('Connected to Redis');
});

// Cache helper functions
export async function cacheGet<T>(key: string): Promise<T | null> {
  const data = await redis.get(key);
  if (data) {
    return JSON.parse(data) as T;
  }
  return null;
}

export async function cacheSet(key: string, value: unknown, ttlSeconds = 300): Promise<void> {
  await redis.setex(key, ttlSeconds, JSON.stringify(value));
}

export async function cacheDelete(key: string): Promise<void> {
  await redis.del(key);
}

export async function cacheDeletePattern(pattern: string): Promise<void> {
  const keys = await redis.keys(pattern);
  if (keys.length > 0) {
    await redis.del(...keys);
  }
}

// Session management
export async function setSession(sessionId: string, userId: string, data: Record<string, unknown>): Promise<void> {
  const sessionData = { userId, ...data };
  await redis.setex(`session:${sessionId}`, 86400, JSON.stringify(sessionData)); // 24 hours
}

export async function getSession(sessionId: string): Promise<{ userId: string; [key: string]: unknown } | null> {
  const data = await redis.get(`session:${sessionId}`);
  if (data) {
    return JSON.parse(data);
  }
  return null;
}

export async function deleteSession(sessionId: string): Promise<void> {
  await redis.del(`session:${sessionId}`);
}
