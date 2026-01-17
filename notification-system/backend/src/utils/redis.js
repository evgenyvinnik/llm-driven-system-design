import Redis from 'ioredis';

export const redis = new Redis({
  host: process.env.REDIS_HOST || 'localhost',
  port: parseInt(process.env.REDIS_PORT || '6379'),
  maxRetriesPerRequest: 3,
  retryDelayOnFailover: 100,
  lazyConnect: true,
});

redis.on('error', (err) => {
  console.error('Redis connection error:', err);
});

redis.on('connect', () => {
  console.log('Redis connected');
});

// Helper functions for common operations
export async function cacheGet(key) {
  const value = await redis.get(key);
  return value ? JSON.parse(value) : null;
}

export async function cacheSet(key, value, ttlSeconds = 300) {
  await redis.setex(key, ttlSeconds, JSON.stringify(value));
}

export async function cacheDelete(key) {
  await redis.del(key);
}

export async function incrementCounter(key, ttlSeconds = 3600) {
  const count = await redis.incr(key);
  if (count === 1) {
    await redis.expire(key, ttlSeconds);
  }
  return count;
}

export async function getCounter(key) {
  const value = await redis.get(key);
  return parseInt(value) || 0;
}
