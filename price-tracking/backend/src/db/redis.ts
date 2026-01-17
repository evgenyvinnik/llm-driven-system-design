import Redis from 'ioredis';
import dotenv from 'dotenv';

dotenv.config();

/**
 * Redis client instance for caching, session management, and pub/sub messaging.
 * Redis serves as the backbone for high-performance operations like session lookup,
 * scrape queue management, and real-time price update notifications.
 */
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

/** Key prefix for session tokens in Redis */
export const sessionPrefix = 'session:';

/** Session time-to-live in seconds (7 days) */
export const sessionTTL = 60 * 60 * 24 * 7;

/**
 * Stores a user session in Redis with automatic expiration.
 * Used for fast session validation without database hits.
 * @param token - The session token to store
 * @param userId - The user ID associated with the session
 */
export async function setSession(token: string, userId: string): Promise<void> {
  await redis.set(`${sessionPrefix}${token}`, userId, 'EX', sessionTTL);
}

/**
 * Retrieves a user ID from a session token.
 * Returns null if the session has expired or doesn't exist.
 * @param token - The session token to look up
 * @returns The user ID or null if not found
 */
export async function getSession(token: string): Promise<string | null> {
  return redis.get(`${sessionPrefix}${token}`);
}

/**
 * Removes a session from Redis, effectively logging out the user.
 * @param token - The session token to delete
 */
export async function deleteSession(token: string): Promise<void> {
  await redis.del(`${sessionPrefix}${token}`);
}

/**
 * Retrieves a cached value by key and deserializes it from JSON.
 * Used for caching product data, user products, and price history.
 * @param key - The cache key to look up
 * @returns The cached value or null if not found
 */
export async function cacheGet<T>(key: string): Promise<T | null> {
  const data = await redis.get(key);
  if (data) {
    return JSON.parse(data) as T;
  }
  return null;
}

/**
 * Stores a value in the cache with automatic expiration.
 * Serializes the value to JSON before storage.
 * @param key - The cache key
 * @param value - The value to cache (will be JSON serialized)
 * @param ttlSeconds - Time-to-live in seconds (default: 5 minutes)
 */
export async function cacheSet(key: string, value: unknown, ttlSeconds: number = 300): Promise<void> {
  await redis.set(key, JSON.stringify(value), 'EX', ttlSeconds);
}

/**
 * Removes a value from the cache.
 * Used when data is updated to ensure fresh reads.
 * @param key - The cache key to delete
 */
export async function cacheDelete(key: string): Promise<void> {
  await redis.del(key);
}

/** Redis key for the priority-sorted scrape queue */
export const scrapeQueueKey = 'scrape:queue';

/** Redis key for the set of currently in-progress scrapes */
export const scrapeInProgressKey = 'scrape:in_progress';

/**
 * Adds a product to the scrape queue with priority ordering.
 * Uses Redis sorted sets with priority as score (lower = higher priority).
 * @param productId - The product ID to queue for scraping
 * @param priority - Priority level (1-10, lower is more urgent)
 */
export async function addToScrapeQueue(productId: string, priority: number): Promise<void> {
  await redis.zadd(scrapeQueueKey, priority, productId);
}

/**
 * Retrieves the next highest-priority product from the scrape queue.
 * Atomically removes from queue and marks as in-progress to prevent duplicate processing.
 * @returns The product ID or null if queue is empty
 */
export async function getNextScrapeJob(): Promise<string | null> {
  const result = await redis.zpopmin(scrapeQueueKey, 1);
  if (result.length > 0) {
    const productId = result[0];
    await redis.sadd(scrapeInProgressKey, productId);
    return productId;
  }
  return null;
}

/**
 * Marks a scrape job as completed by removing it from the in-progress set.
 * @param productId - The product ID that finished scraping
 */
export async function markScrapeComplete(productId: string): Promise<void> {
  await redis.srem(scrapeInProgressKey, productId);
}

/**
 * Checks if a domain's rate limit has been exceeded.
 * Implements a sliding window rate limiter using Redis counters.
 * @param domain - The domain to check rate limit for
 * @param limit - Maximum requests allowed per minute
 * @returns True if request is allowed, false if rate limited
 */
export async function checkRateLimit(domain: string, limit: number): Promise<boolean> {
  const key = `ratelimit:${domain}`;
  const current = await redis.incr(key);
  if (current === 1) {
    await redis.expire(key, 60);
  }
  return current <= limit;
}

/** Redis pub/sub channel for real-time price update notifications */
export const priceUpdateChannel = 'price:updates';

/** Redis pub/sub channel for new alert notifications */
export const alertChannel = 'alerts:new';

/**
 * Publishes a price update event for real-time client notifications.
 * Subscribers can use this to update UI without polling.
 * @param productId - The product that had a price change
 * @param newPrice - The new price value
 * @param oldPrice - The previous price value (null if first scrape)
 */
export async function publishPriceUpdate(productId: string, newPrice: number, oldPrice: number | null): Promise<void> {
  await redis.publish(priceUpdateChannel, JSON.stringify({ productId, newPrice, oldPrice, timestamp: new Date() }));
}

/**
 * Publishes a new alert event for real-time notification delivery.
 * Enables instant push notifications when price targets are met.
 * @param alert - Alert details including user, product, type, and price
 */
export async function publishAlert(alert: { userId: string; productId: string; type: string; newPrice: number }): Promise<void> {
  await redis.publish(alertChannel, JSON.stringify(alert));
}
