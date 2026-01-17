import Redis from 'ioredis';

const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379', {
  maxRetriesPerRequest: 3,
  retryDelayOnFailover: 100,
  lazyConnect: true,
});

redis.on('error', (err) => {
  console.error('Redis connection error:', err);
});

redis.on('connect', () => {
  console.log('Connected to Redis');
});

// Pub/Sub clients for real-time messaging
export const pubClient = redis.duplicate();
export const subClient = redis.duplicate();

// Session helpers
export async function setSession(token, data, expirySeconds = 30 * 24 * 60 * 60) {
  await redis.setex(`session:${token}`, expirySeconds, JSON.stringify(data));
}

export async function getSession(token) {
  const data = await redis.get(`session:${token}`);
  return data ? JSON.parse(data) : null;
}

export async function deleteSession(token) {
  await redis.del(`session:${token}`);
}

// Presence helpers
export async function setPresence(userId, deviceId, status = 'online') {
  const key = `presence:${userId}`;
  const data = JSON.stringify({
    status,
    deviceId,
    lastSeen: Date.now(),
  });
  await redis.setex(key, 60, data); // 60 seconds TTL, refreshed by heartbeat
}

export async function getPresence(userId) {
  const data = await redis.get(`presence:${userId}`);
  return data ? JSON.parse(data) : null;
}

export async function deletePresence(userId) {
  await redis.del(`presence:${userId}`);
}

// Typing indicator helpers
export async function setTyping(conversationId, userId, isTyping) {
  const key = `typing:${conversationId}`;
  if (isTyping) {
    await redis.hset(key, userId, Date.now());
    await redis.expire(key, 5); // 5 seconds TTL
  } else {
    await redis.hdel(key, userId);
  }
}

export async function getTypingUsers(conversationId) {
  const key = `typing:${conversationId}`;
  const typing = await redis.hgetall(key);
  const now = Date.now();
  const activeTypers = [];

  for (const [userId, timestamp] of Object.entries(typing)) {
    if (now - parseInt(timestamp) < 5000) {
      activeTypers.push(userId);
    }
  }

  return activeTypers;
}

// Offline message queue
export async function queueOfflineMessage(userId, deviceId, message) {
  const key = `offline:${userId}:${deviceId}`;
  await redis.rpush(key, JSON.stringify(message));
  await redis.expire(key, 7 * 24 * 60 * 60); // 7 days TTL
}

export async function getOfflineMessages(userId, deviceId) {
  const key = `offline:${userId}:${deviceId}`;
  const messages = await redis.lrange(key, 0, -1);
  await redis.del(key);
  return messages.map(msg => JSON.parse(msg));
}

// WebSocket connection tracking
export async function addConnection(userId, deviceId, serverId) {
  await redis.hset(`connections:${userId}`, deviceId, serverId);
}

export async function removeConnection(userId, deviceId) {
  await redis.hdel(`connections:${userId}`, deviceId);
}

export async function getUserConnections(userId) {
  return await redis.hgetall(`connections:${userId}`);
}

export default redis;
