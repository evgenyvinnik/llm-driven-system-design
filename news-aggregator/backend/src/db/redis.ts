import Redis from 'ioredis';

/**
 * Redis client instance for caching and session storage.
 * Provides fast in-memory data storage for feed caching and user sessions.
 */
export const redis = new Redis({
  host: process.env.REDIS_HOST || 'localhost',
  port: parseInt(process.env.REDIS_PORT || '6379'),
  maxRetriesPerRequest: 3,
});

/**
 * Retrieve a cached value by key.
 * Automatically deserializes JSON data stored in Redis.
 * @param key - The cache key to look up
 * @returns The cached value typed as T, or null if not found or expired
 */
export async function getCache<T>(key: string): Promise<T | null> {
  const data = await redis.get(key);
  if (!data) return null;
  return JSON.parse(data) as T;
}

/**
 * Store a value in cache with expiration.
 * Automatically serializes objects to JSON for storage.
 * @param key - The cache key under which to store the value
 * @param value - The value to cache (will be JSON serialized)
 * @param ttlSeconds - Time-to-live in seconds (default: 300 = 5 minutes)
 */
export async function setCache(key: string, value: unknown, ttlSeconds = 300): Promise<void> {
  await redis.setex(key, ttlSeconds, JSON.stringify(value));
}

/**
 * Remove a value from the cache.
 * Used to invalidate stale data when underlying content changes.
 * @param key - The cache key to delete
 */
export async function deleteCache(key: string): Promise<void> {
  await redis.del(key);
}

/**
 * Session storage interface using Redis.
 * Provides authenticated user session management with automatic expiration.
 * Sessions are stored with a 24-hour TTL and prefixed with 'session:'.
 */
export const sessionStore = {
  /**
   * Retrieve a user session by session ID.
   * @param sessionId - The unique session identifier
   * @returns Session data object or null if session doesn't exist or expired
   */
  async get(sessionId: string): Promise<Record<string, unknown> | null> {
    return getCache(`session:${sessionId}`);
  },

  /**
   * Create or update a user session.
   * Sessions automatically expire after 24 hours.
   * @param sessionId - The unique session identifier
   * @param data - Session data (typically contains userId and role)
   */
  async set(sessionId: string, data: Record<string, unknown>): Promise<void> {
    await setCache(`session:${sessionId}`, data, 86400); // 24 hours
  },

  /**
   * Destroy a user session (logout).
   * @param sessionId - The session identifier to invalidate
   */
  async destroy(sessionId: string): Promise<void> {
    await deleteCache(`session:${sessionId}`);
  },
};
