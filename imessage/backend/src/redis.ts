import { Redis } from 'ioredis';

export type RedisClient = Redis;

export interface SessionData {
  userId: string;
  deviceId: string;
  expiresAt: string;
}

const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379', {
  maxRetriesPerRequest: 3,
  lazyConnect: true,
});

redis.on('error', (err: Error) => {
  console.error('Redis connection error:', err);
});

redis.on('connect', () => {
  console.log('Connected to Redis');
});

// Pub/Sub clients for real-time messaging
export const pubClient = redis.duplicate();
export const subClient = redis.duplicate();

/** Stores a session token to user data mapping in Redis with configurable expiry. */
export async function setSession(
  token: string,
  data: SessionData,
  expirySeconds: number = 30 * 24 * 60 * 60
): Promise<void> {
  await redis.setex(`session:${token}`, expirySeconds, JSON.stringify(data));
}

/** Retrieves session data for a token from Redis. */
export async function getSession(token: string): Promise<SessionData | null> {
  const data = await redis.get(`session:${token}`);
  return data ? JSON.parse(data) : null;
}

/** Deletes a session token from Redis on logout. */
export async function deleteSession(token: string): Promise<void> {
  await redis.del(`session:${token}`);
}

/**
 * Presence is tracked per connection, not per user: `presence:{userId}` is a
 * sorted set of connection IDs scored by their last heartbeat. A user is
 * online while at least one connection has a fresh heartbeat, so closing one
 * tab or device no longer marks a user with other live devices as offline,
 * and connections on a crashed server age out instead of staying "online".
 */
export const PRESENCE_STALE_MS = 90_000;

/** Records a heartbeat for a connection; returns the user's live connection count. */
export async function touchPresence(userId: string, connectionId: string): Promise<number> {
  const key = `presence:${userId}`;
  const now = Date.now();
  const results = await redis
    .multi()
    .zadd(key, now, connectionId)
    .zremrangebyscore(key, 0, now - PRESENCE_STALE_MS)
    .pexpire(key, PRESENCE_STALE_MS * 2)
    .zcard(key)
    .exec();
  return Number(results?.[3]?.[1] ?? 0);
}

/** Removes a connection; returns how many live connections the user still has. */
export async function dropPresence(userId: string, connectionId: string): Promise<number> {
  const key = `presence:${userId}`;
  const results = await redis
    .multi()
    .zrem(key, connectionId)
    .zremrangebyscore(key, 0, Date.now() - PRESENCE_STALE_MS)
    .zcard(key)
    .exec();
  return Number(results?.[2]?.[1] ?? 0);
}

/** Sets or clears a typing indicator for a user in a conversation with 5-second TTL. */
export async function setTyping(
  conversationId: string,
  userId: string,
  isTyping: boolean
): Promise<void> {
  const key = `typing:${conversationId}`;
  if (isTyping) {
    await redis.hset(key, userId, Date.now());
    await redis.expire(key, 5); // 5 seconds TTL
  } else {
    await redis.hdel(key, userId);
  }
}

/** Returns user IDs currently typing in a conversation, filtering out stale indicators. */
export async function getTypingUsers(conversationId: string): Promise<string[]> {
  const key = `typing:${conversationId}`;
  const typing = await redis.hgetall(key);
  const now = Date.now();
  const activeTypers: string[] = [];

  for (const [userId, timestamp] of Object.entries(typing)) {
    if (now - parseInt(timestamp as string) < 5000) {
      activeTypers.push(userId);
    }
  }

  return activeTypers;
}

export default redis;
