import Redis from 'ioredis';
import { REDIS_CONFIG } from '../config.js';

export const redis = new Redis({
  host: REDIS_CONFIG.host,
  port: REDIS_CONFIG.port,
  retryStrategy: (times) => {
    const delay = Math.min(times * 50, 2000);
    return delay;
  },
});

redis.on('error', (err) => {
  console.error('Redis connection error:', err);
});

redis.on('connect', () => {
  console.log('Connected to Redis');
});

// Session helpers
const SESSION_PREFIX = 'session:';
const SESSION_TTL = 7 * 24 * 60 * 60; // 7 days in seconds

export interface Session {
  accountId: string;
  profileId?: string;
  deviceInfo?: {
    userAgent?: string;
    ip?: string;
  };
  createdAt: string;
}

export async function setSession(token: string, session: Session): Promise<void> {
  await redis.setex(`${SESSION_PREFIX}${token}`, SESSION_TTL, JSON.stringify(session));
}

export async function getSession(token: string): Promise<Session | null> {
  const data = await redis.get(`${SESSION_PREFIX}${token}`);
  if (!data) return null;
  return JSON.parse(data) as Session;
}

export async function deleteSession(token: string): Promise<void> {
  await redis.del(`${SESSION_PREFIX}${token}`);
}

// Cache helpers
const CACHE_PREFIX = 'cache:';

export async function getCached<T>(key: string): Promise<T | null> {
  const data = await redis.get(`${CACHE_PREFIX}${key}`);
  if (!data) return null;
  return JSON.parse(data) as T;
}

export async function setCache<T>(key: string, value: T, ttlSeconds = 300): Promise<void> {
  await redis.setex(`${CACHE_PREFIX}${key}`, ttlSeconds, JSON.stringify(value));
}

export async function deleteCache(key: string): Promise<void> {
  await redis.del(`${CACHE_PREFIX}${key}`);
}

export async function deleteCachePattern(pattern: string): Promise<void> {
  const keys = await redis.keys(`${CACHE_PREFIX}${pattern}`);
  if (keys.length > 0) {
    await redis.del(...keys);
  }
}
