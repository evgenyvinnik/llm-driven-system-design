import Redis from 'ioredis';

// Create Redis client
const redis = new Redis({
  host: process.env.REDIS_HOST || 'localhost',
  port: parseInt(process.env.REDIS_PORT || '6379'),
  maxRetriesPerRequest: 3,
  retryStrategy: (times) => {
    if (times > 3) {
      console.error('Redis connection failed after 3 retries');
      return null;
    }
    return Math.min(times * 200, 2000);
  },
});

redis.on('connect', () => {
  console.log('Redis connected');
});

redis.on('error', (err) => {
  console.error('Redis error:', err);
});

// Session management
export const SESSION_PREFIX = 'session:';
export const SESSION_TTL = 60 * 60 * 24 * 7; // 7 days

// Presence management
export const PRESENCE_PREFIX = 'presence:';
export const PRESENCE_TTL = 60; // 1 minute

export async function setSession(token: string, userId: string): Promise<void> {
  await redis.setex(`${SESSION_PREFIX}${token}`, SESSION_TTL, userId);
}

export async function getSession(token: string): Promise<string | null> {
  return redis.get(`${SESSION_PREFIX}${token}`);
}

export async function deleteSession(token: string): Promise<void> {
  await redis.del(`${SESSION_PREFIX}${token}`);
}

export async function setPresence(pageId: string, userId: string, data: string): Promise<void> {
  await redis.hset(`${PRESENCE_PREFIX}${pageId}`, userId, data);
  await redis.expire(`${PRESENCE_PREFIX}${pageId}`, PRESENCE_TTL);
}

export async function getPresence(pageId: string): Promise<Record<string, string>> {
  return redis.hgetall(`${PRESENCE_PREFIX}${pageId}`);
}

export async function removePresence(pageId: string, userId: string): Promise<void> {
  await redis.hdel(`${PRESENCE_PREFIX}${pageId}`, userId);
}

export default redis;
