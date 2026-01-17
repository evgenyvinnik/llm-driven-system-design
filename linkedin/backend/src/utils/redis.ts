import Redis from 'ioredis';

/**
 * Redis client configuration for caching and session storage.
 * Provides connection pooling and automatic retry logic for resilience.
 */
const redisConfig = {
  host: process.env.REDIS_HOST || 'localhost',
  port: parseInt(process.env.REDIS_PORT || '6379'),
  maxRetriesPerRequest: 3,
  retryDelayOnFailover: 100,
};

/**
 * Redis client singleton for caching operations.
 * Used to cache feed data, connection lists, and PYMK recommendations
 * to reduce database load and improve response times.
 */
export const redis = new Redis(redisConfig);

redis.on('error', (err) => {
  console.error('Redis connection error:', err);
});

redis.on('connect', () => {
  console.log('Connected to Redis');
});

/**
 * Retrieves a cached value by key and deserializes it from JSON.
 * Returns null if the key does not exist or has expired.
 *
 * @template T - The expected type of the cached value
 * @param key - The cache key to look up
 * @returns Promise resolving to the cached value, or null if not found
 */
export async function cacheGet<T>(key: string): Promise<T | null> {
  const data = await redis.get(key);
  if (!data) return null;
  return JSON.parse(data) as T;
}

/**
 * Stores a value in the cache with automatic expiration.
 * Values are JSON serialized before storage for type preservation.
 *
 * @param key - The cache key to store under
 * @param value - The value to cache (will be JSON serialized)
 * @param ttlSeconds - Time to live in seconds (default: 1 hour)
 */
export async function cacheSet(key: string, value: unknown, ttlSeconds = 3600): Promise<void> {
  await redis.setex(key, ttlSeconds, JSON.stringify(value));
}

/**
 * Deletes a single cache entry by key.
 * Used to invalidate specific cached data after mutations.
 *
 * @param key - The cache key to delete
 */
export async function cacheDel(key: string): Promise<void> {
  await redis.del(key);
}

/**
 * Deletes all cache entries matching a glob pattern.
 * Useful for bulk invalidation (e.g., clearing all feed caches).
 * Warning: KEYS command can be slow on large datasets.
 *
 * @param pattern - Redis glob pattern (e.g., "feed:*" or "user:123:*")
 */
export async function cacheDelPattern(pattern: string): Promise<void> {
  const keys = await redis.keys(pattern);
  if (keys.length > 0) {
    await redis.del(...keys);
  }
}
