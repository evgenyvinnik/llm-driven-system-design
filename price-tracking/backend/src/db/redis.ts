import Redis from 'ioredis';
import dotenv from 'dotenv';

dotenv.config();

const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379', {
  maxRetriesPerRequest: 3,
  retryStrategy(times) {
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

export default redis;

// Session management
export const sessionPrefix = 'session:';
export const sessionTTL = 60 * 60 * 24 * 7; // 7 days

export async function setSession(token: string, userId: string): Promise<void> {
  await redis.set(`${sessionPrefix}${token}`, userId, 'EX', sessionTTL);
}

export async function getSession(token: string): Promise<string | null> {
  return redis.get(`${sessionPrefix}${token}`);
}

export async function deleteSession(token: string): Promise<void> {
  await redis.del(`${sessionPrefix}${token}`);
}

// Cache helpers
export async function cacheGet<T>(key: string): Promise<T | null> {
  const data = await redis.get(key);
  if (data) {
    return JSON.parse(data) as T;
  }
  return null;
}

export async function cacheSet(key: string, value: unknown, ttlSeconds: number = 300): Promise<void> {
  await redis.set(key, JSON.stringify(value), 'EX', ttlSeconds);
}

export async function cacheDelete(key: string): Promise<void> {
  await redis.del(key);
}

// Scrape queue management
export const scrapeQueueKey = 'scrape:queue';
export const scrapeInProgressKey = 'scrape:in_progress';

export async function addToScrapeQueue(productId: string, priority: number): Promise<void> {
  // Use sorted set with priority as score (lower = higher priority)
  await redis.zadd(scrapeQueueKey, priority, productId);
}

export async function getNextScrapeJob(): Promise<string | null> {
  // Get the highest priority (lowest score) item
  const result = await redis.zpopmin(scrapeQueueKey, 1);
  if (result.length > 0) {
    const productId = result[0];
    // Mark as in progress
    await redis.sadd(scrapeInProgressKey, productId);
    return productId;
  }
  return null;
}

export async function markScrapeComplete(productId: string): Promise<void> {
  await redis.srem(scrapeInProgressKey, productId);
}

// Rate limiting for scraper
export async function checkRateLimit(domain: string, limit: number): Promise<boolean> {
  const key = `ratelimit:${domain}`;
  const current = await redis.incr(key);
  if (current === 1) {
    await redis.expire(key, 60); // 1 minute window
  }
  return current <= limit;
}

// Pub/Sub for real-time updates
export const priceUpdateChannel = 'price:updates';
export const alertChannel = 'alerts:new';

export async function publishPriceUpdate(productId: string, newPrice: number, oldPrice: number | null): Promise<void> {
  await redis.publish(priceUpdateChannel, JSON.stringify({ productId, newPrice, oldPrice, timestamp: new Date() }));
}

export async function publishAlert(alert: { userId: string; productId: string; type: string; newPrice: number }): Promise<void> {
  await redis.publish(alertChannel, JSON.stringify(alert));
}
