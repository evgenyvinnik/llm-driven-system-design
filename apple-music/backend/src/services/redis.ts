import { Redis } from 'ioredis';

/** Redis client instance for session caching, rate limiting, and idempotency storage. */
export const redis = new Redis({
  host: process.env.REDIS_HOST || 'localhost',
  port: parseInt(process.env.REDIS_PORT || '6379', 10),
  retryStrategy: (times: number) => Math.min(times * 100, 3000),
  maxRetriesPerRequest: 3
});

redis.on('connect', () => {
  console.log('Connected to Redis');
});

redis.on('error', (err: Error) => {
  console.error('Redis connection error:', err);
});

/**
 * Deletes every key matching a glob pattern (e.g. "artists:*") and returns how many were removed.
 * DEL never expands patterns — `redis.del('artists:*')` only removes a key literally named
 * "artists:*" — so the pattern is walked with SCAN, which unlike KEYS does not block the server.
 */
export async function deleteByPattern(pattern: string): Promise<number> {
  let cursor = '0';
  let deleted = 0;
  do {
    const [next, keys] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
    if (keys.length > 0) {
      deleted += await redis.del(...keys);
    }
    cursor = next;
  } while (cursor !== '0');
  return deleted;
}

export default redis;
