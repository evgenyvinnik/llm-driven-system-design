import Redis from 'ioredis';
import config from '../config/index.js';

const redis = new Redis.default({
  host: config.redis.host,
  port: config.redis.port,
  retryStrategy: (times: number): number => Math.min(times * 100, 3000),
  maxRetriesPerRequest: 3,
});

redis.on('error', (err: Error) => {
  console.error('Redis connection error:', err);
});

redis.on('connect', () => {
  console.log('Connected to Redis');
});

// Cache helpers. The cache is an optimization: every helper fails open
// (a Redis error is logged and treated as a miss / no-op) so an unavailable
// cache can never turn a committed write into an error response.

/** Retrieves a JSON-parsed value from Redis cache by key, or null on miss or error. */
export const cacheGet = async <T = unknown>(key: string): Promise<T | null> => {
  try {
    const data = await redis.get(key);
    return data ? (JSON.parse(data) as T) : null;
  } catch (err) {
    console.warn('cacheGet failed; treating as a miss', (err as Error).message);
    return null;
  }
};

/** Stores a JSON-serialized value in Redis cache with configurable TTL. */
export const cacheSet = async (
  key: string,
  value: unknown,
  ttlSeconds: number = 3600
): Promise<void> => {
  try {
    await redis.set(key, JSON.stringify(value), 'EX', ttlSeconds);
  } catch (err) {
    console.warn('cacheSet failed; continuing uncached', (err as Error).message);
  }
};

/**
 * Per-user cache generation. Every cached mailbox view for a user (thread
 * lists for any label/page, unread counts) embeds the current generation in
 * its key, so invalidating all of them is one INCR. The previous code called
 * DEL on a key containing a literal `*`; Redis DEL does not expand patterns,
 * so nothing was ever invalidated and lists stayed stale for 30 seconds.
 * Superseded keys simply expire with their TTL.
 */
export const mailboxGeneration = async (userId: string): Promise<string> => {
  try {
    return (await redis.get(`mailbox-gen:${userId}`)) ?? '0';
  } catch {
    // Without the generation we cannot build a trustworthy key; a unique value
    // makes this request read through to the database.
    return `nocache-${Date.now()}-${Math.random()}`;
  }
};

/** Invalidates every cached mailbox view for these users. Call after commit. */
export const invalidateMailboxes = async (...userIds: string[]): Promise<void> => {
  for (const userId of new Set(userIds)) {
    try {
      await redis.incr(`mailbox-gen:${userId}`);
    } catch (err) {
      console.warn('Mailbox invalidation failed; entries expire with their TTL', (err as Error).message);
    }
  }
};

export default redis;
