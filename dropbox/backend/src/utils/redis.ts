import Redis from 'ioredis';

const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';

export const redis = new Redis(redisUrl, {
  maxRetriesPerRequest: 3,
  retryDelayOnFailover: 100,
  retryDelayOnClusterDown: 100,
});

redis.on('error', (err) => {
  console.error('Redis connection error:', err);
});

redis.on('connect', () => {
  console.log('Connected to Redis');
});

// Session helpers
export async function setSession(token: string, userId: string, expirySeconds: number): Promise<void> {
  await redis.setex(`session:${token}`, expirySeconds, userId);
}

export async function getSession(token: string): Promise<string | null> {
  return redis.get(`session:${token}`);
}

export async function deleteSession(token: string): Promise<void> {
  await redis.del(`session:${token}`);
}

// Cache helpers
export async function setCache(key: string, value: unknown, expirySeconds: number = 3600): Promise<void> {
  await redis.setex(`cache:${key}`, expirySeconds, JSON.stringify(value));
}

export async function getCache<T>(key: string): Promise<T | null> {
  const data = await redis.get(`cache:${key}`);
  if (!data) return null;
  return JSON.parse(data) as T;
}

export async function deleteCache(key: string): Promise<void> {
  await redis.del(`cache:${key}`);
}

// Pub/Sub for real-time sync notifications
export const redisSub = new Redis(redisUrl);
export const redisPub = new Redis(redisUrl);

export async function publishSync(userId: string, event: object): Promise<void> {
  await redisPub.publish(`sync:${userId}`, JSON.stringify(event));
}
