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

// Cache helpers
/** Retrieves and deserializes a cached value by key. */
export const cacheGet = async <T = unknown>(key: string): Promise<T | null> => {
  const data = await redis.get(key);
  return data ? (JSON.parse(data) as T) : null;
};

/** Serializes and stores a value in Redis with a TTL. */
export const cacheSet = async (key: string, value: unknown, ttlSeconds: number = 3600): Promise<void> => {
  await redis.set(key, JSON.stringify(value), 'EX', ttlSeconds);
};

/** Deletes a single cache entry by key. */
export const cacheDel = async (key: string): Promise<void> => {
  await redis.del(key);
};

// Post detail cache. Entries carry the post's status and its author's privacy flag so the
// visibility check still runs on a cache hit. Only published posts are cached.
/** Cache key for a post detail entry. */
export const postCacheKey = (postId: string): string => `post:v2:${postId}`;

/** Drops a cached post; call on every write that changes what GET /posts/:id returns. */
export const invalidatePostCache = async (postId: string): Promise<void> => {
  await redis.del(postCacheKey(postId));
};

// Story tray cache
export interface StoryTrayUser {
  id: string;
  username: string;
  displayName: string;
  profilePictureUrl: string | null;
  storyCount: number;
  hasSeen: boolean;
  latestStoryTime: string;
}

const storyTrayKey = (userId: string): string => `story_tray:${userId}`;

/** Caches the story tray data for a user (default 60 s; callers bound it by the earliest expiry). */
export const storyTraySet = async (
  userId: string,
  stories: StoryTrayUser[],
  ttlSeconds: number = 60
): Promise<void> => {
  await redis.set(storyTrayKey(userId), JSON.stringify(stories), 'EX', Math.max(1, ttlSeconds));
};

/** Retrieves cached story tray data for a user. */
export const storyTrayGet = async (userId: string): Promise<StoryTrayUser[] | null> => {
  const data = await redis.get(storyTrayKey(userId));
  return data ? (JSON.parse(data) as StoryTrayUser[]) : null;
};

/** Drops cached story trays (e.g. the author's followers after a new story). */
export const invalidateStoryTrays = async (userIds: string[]): Promise<void> => {
  if (userIds.length === 0) return;
  await redis.del(...userIds.map(storyTrayKey));
};

export default redis;
