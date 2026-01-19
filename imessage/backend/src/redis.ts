import { Redis } from 'ioredis';

export type RedisClient = Redis;

export interface SessionData {
  userId: string;
  deviceId: string;
  expiresAt: string;
}

export interface PresenceData {
  status: string;
  deviceId: string;
  lastSeen: number;
}

export interface OfflineMessage {
  type: string;
  message?: unknown;
  [key: string]: unknown;
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

// Session helpers
export async function setSession(
  token: string,
  data: SessionData,
  expirySeconds: number = 30 * 24 * 60 * 60
): Promise<void> {
  await redis.setex(`session:${token}`, expirySeconds, JSON.stringify(data));
}

export async function getSession(token: string): Promise<SessionData | null> {
  const data = await redis.get(`session:${token}`);
  return data ? JSON.parse(data) : null;
}

export async function deleteSession(token: string): Promise<void> {
  await redis.del(`session:${token}`);
}

// Presence helpers
export async function setPresence(
  userId: string,
  deviceId: string,
  status: string = 'online'
): Promise<void> {
  const key = `presence:${userId}`;
  const data = JSON.stringify({
    status,
    deviceId,
    lastSeen: Date.now(),
  });
  await redis.setex(key, 60, data); // 60 seconds TTL, refreshed by heartbeat
}

export async function getPresence(userId: string): Promise<PresenceData | null> {
  const data = await redis.get(`presence:${userId}`);
  return data ? JSON.parse(data) : null;
}

export async function deletePresence(userId: string): Promise<void> {
  await redis.del(`presence:${userId}`);
}

// Typing indicator helpers
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

// Offline message queue
export async function queueOfflineMessage(
  userId: string,
  deviceId: string,
  message: OfflineMessage
): Promise<void> {
  const key = `offline:${userId}:${deviceId}`;
  await redis.rpush(key, JSON.stringify(message));
  await redis.expire(key, 7 * 24 * 60 * 60); // 7 days TTL
}

export async function getOfflineMessages(
  userId: string,
  deviceId: string
): Promise<OfflineMessage[]> {
  const key = `offline:${userId}:${deviceId}`;
  const messages = await redis.lrange(key, 0, -1);
  await redis.del(key);
  return messages.map((msg: string) => JSON.parse(msg) as OfflineMessage);
}

// WebSocket connection tracking
export async function addConnection(
  userId: string,
  deviceId: string,
  serverId: string
): Promise<void> {
  await redis.hset(`connections:${userId}`, deviceId, serverId);
}

export async function removeConnection(userId: string, deviceId: string): Promise<void> {
  await redis.hdel(`connections:${userId}`, deviceId);
}

export async function getUserConnections(userId: string): Promise<Record<string, string>> {
  return await redis.hgetall(`connections:${userId}`);
}

export default redis;
