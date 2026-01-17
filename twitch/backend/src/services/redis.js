const { createClient } = require('redis');

let redisClient = null;
let subscriberClient = null;

async function initRedis() {
  const url = process.env.REDIS_URL || 'redis://localhost:6379';

  // Main client for commands
  redisClient = createClient({ url });
  redisClient.on('error', (err) => console.error('Redis Client Error:', err));
  await redisClient.connect();

  // Separate client for subscriptions
  subscriberClient = redisClient.duplicate();
  await subscriberClient.connect();

  return redisClient;
}

function getRedisClient() {
  return redisClient;
}

function getSubscriberClient() {
  return subscriberClient;
}

async function publishMessage(channel, message) {
  if (!redisClient) throw new Error('Redis not initialized');
  return redisClient.publish(channel, JSON.stringify(message));
}

async function subscribe(channel, callback) {
  if (!subscriberClient) throw new Error('Redis not initialized');
  return subscriberClient.subscribe(channel, (message) => {
    try {
      callback(JSON.parse(message));
    } catch (e) {
      callback(message);
    }
  });
}

async function unsubscribe(channel) {
  if (!subscriberClient) throw new Error('Redis not initialized');
  return subscriberClient.unsubscribe(channel);
}

// Rate limiting
async function checkRateLimit(userId, channelId, cooldownSeconds = 1) {
  const key = `ratelimit:${channelId}:${userId}`;
  const lastMessage = await redisClient.get(key);

  if (lastMessage) {
    const elapsed = Date.now() - parseInt(lastMessage);
    if (elapsed < cooldownSeconds * 1000) {
      return { allowed: false, waitMs: (cooldownSeconds * 1000) - elapsed };
    }
  }

  await redisClient.set(key, Date.now().toString(), { EX: cooldownSeconds });
  return { allowed: true };
}

// Session management
async function setSession(sessionId, userId, ttlSeconds = 86400) {
  await redisClient.set(`session:${sessionId}`, userId.toString(), { EX: ttlSeconds });
}

async function getSession(sessionId) {
  const userId = await redisClient.get(`session:${sessionId}`);
  return userId ? parseInt(userId) : null;
}

async function deleteSession(sessionId) {
  await redisClient.del(`session:${sessionId}`);
}

// Viewer counts
async function updateViewerCount(channelId, count) {
  await redisClient.set(`viewers:${channelId}`, count.toString());
}

async function getViewerCount(channelId) {
  const count = await redisClient.get(`viewers:${channelId}`);
  return count ? parseInt(count) : 0;
}

module.exports = {
  initRedis,
  getRedisClient,
  getSubscriberClient,
  publishMessage,
  subscribe,
  unsubscribe,
  checkRateLimit,
  setSession,
  getSession,
  deleteSession,
  updateViewerCount,
  getViewerCount
};
