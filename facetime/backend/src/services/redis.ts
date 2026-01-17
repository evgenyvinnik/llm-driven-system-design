import { createClient, RedisClientType } from 'redis';

let redisClient: RedisClientType | null = null;

export async function getRedisClient(): Promise<RedisClientType> {
  if (!redisClient) {
    redisClient = createClient({
      url: process.env.REDIS_URL || 'redis://localhost:6379',
    });

    redisClient.on('error', (err) => {
      console.error('Redis Client Error', err);
    });

    redisClient.on('connect', () => {
      console.log('Redis connected');
    });

    await redisClient.connect();
  }
  return redisClient;
}

export async function closeRedis(): Promise<void> {
  if (redisClient) {
    await redisClient.quit();
    redisClient = null;
  }
}

// Session and presence helpers
export async function setUserOnline(userId: string, deviceId: string): Promise<void> {
  const client = await getRedisClient();
  const key = `presence:${userId}`;
  await client.hSet(key, deviceId, JSON.stringify({
    online: true,
    lastSeen: Date.now(),
  }));
  await client.expire(key, 3600); // 1 hour TTL
}

export async function setUserOffline(userId: string, deviceId: string): Promise<void> {
  const client = await getRedisClient();
  const key = `presence:${userId}`;
  await client.hDel(key, deviceId);
}

export async function getUserPresence(userId: string): Promise<Record<string, unknown>> {
  const client = await getRedisClient();
  const key = `presence:${userId}`;
  return await client.hGetAll(key);
}

export async function isUserOnline(userId: string): Promise<boolean> {
  const presence = await getUserPresence(userId);
  return Object.keys(presence).length > 0;
}

// Call state management
export async function setCallState(callId: string, state: Record<string, unknown>): Promise<void> {
  const client = await getRedisClient();
  await client.set(`call:${callId}`, JSON.stringify(state), { EX: 7200 }); // 2 hour TTL
}

export async function getCallState(callId: string): Promise<Record<string, unknown> | null> {
  const client = await getRedisClient();
  const data = await client.get(`call:${callId}`);
  return data ? JSON.parse(data) : null;
}

export async function deleteCallState(callId: string): Promise<void> {
  const client = await getRedisClient();
  await client.del(`call:${callId}`);
}
