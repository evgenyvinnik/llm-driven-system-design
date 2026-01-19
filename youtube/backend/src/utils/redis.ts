import Redis from 'ioredis';
import config from '../config/index.js';

const redis = new Redis({
  host: config.redis.host,
  port: config.redis.port,
  retryStrategy: (times) => {
    const delay = Math.min(times * 50, 2000);
    return delay;
  },
  maxRetriesPerRequest: 3,
});

redis.on('error', (err) => {
  console.error('Redis connection error:', err.message);
});

redis.on('connect', () => {
  console.log('Connected to Redis');
});

// Cache helpers
export const cacheGet = async (key) => {
  const value = await redis.get(key);
  return value ? JSON.parse(value) : null;
};

export const cacheSet = async (key, value, ttlSeconds = 300) => {
  await redis.setex(key, ttlSeconds, JSON.stringify(value));
};

export const cacheDelete = async (key) => {
  await redis.del(key);
};

// Session helpers
export const sessionGet = async (sessionId) => {
  return cacheGet(`session:${sessionId}`);
};

export const sessionSet = async (sessionId, userData, ttlSeconds = 7 * 24 * 60 * 60) => {
  await cacheSet(`session:${sessionId}`, userData, ttlSeconds);
};

export const sessionDelete = async (sessionId) => {
  await cacheDelete(`session:${sessionId}`);
};

// View count buffering
export const incrementViewCount = async (videoId) => {
  await redis.incr(`views:${videoId}`);
};

export const getBufferedViewCount = async (videoId) => {
  const count = await redis.get(`views:${videoId}`);
  return parseInt(count || '0', 10);
};

export const flushViewCounts = async () => {
  const keys = await redis.keys('views:*');
  const counts = {};

  for (const key of keys) {
    const videoId = key.split(':')[1];
    const count = await redis.getset(key, 0);
    if (parseInt(count, 10) > 0) {
      counts[videoId] = parseInt(count, 10);
    }
  }

  return counts;
};

// Trending videos
export const updateTrendingScore = async (videoId, score) => {
  await redis.zadd('trending:global', score, videoId);
  // Keep only top 100
  await redis.zremrangebyrank('trending:global', 0, -101);
};

export const getTrendingVideos = async (limit = 50) => {
  return redis.zrevrange('trending:global', 0, limit - 1);
};

export default redis;
