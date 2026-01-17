import Redis from 'ioredis';

export const redis = new Redis({
  host: process.env.REDIS_HOST || 'localhost',
  port: parseInt(process.env.REDIS_PORT || '6379'),
  maxRetriesPerRequest: 3,
});

// Cache helper functions
export async function getCache<T>(key: string): Promise<T | null> {
  const data = await redis.get(key);
  if (!data) return null;
  return JSON.parse(data) as T;
}

export async function setCache(key: string, value: unknown, ttlSeconds = 300): Promise<void> {
  await redis.setex(key, ttlSeconds, JSON.stringify(value));
}

export async function deleteCache(key: string): Promise<void> {
  await redis.del(key);
}

// Session store for authentication
export const sessionStore = {
  async get(sessionId: string): Promise<Record<string, unknown> | null> {
    return getCache(`session:${sessionId}`);
  },
  async set(sessionId: string, data: Record<string, unknown>): Promise<void> {
    await setCache(`session:${sessionId}`, data, 86400); // 24 hours
  },
  async destroy(sessionId: string): Promise<void> {
    await deleteCache(`session:${sessionId}`);
  },
};
