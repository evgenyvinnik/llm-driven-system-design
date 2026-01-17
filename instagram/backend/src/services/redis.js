import Redis from 'ioredis';
import config from '../config/index.js';

const redis = new Redis({
  host: config.redis.host,
  port: config.redis.port,
  retryDelayOnFailover: 100,
  maxRetriesPerRequest: 3,
});

redis.on('error', (err) => {
  console.error('Redis connection error:', err);
});

redis.on('connect', () => {
  console.log('Connected to Redis');
});

// Cache helpers
export const cacheGet = async (key) => {
  const data = await redis.get(key);
  return data ? JSON.parse(data) : null;
};

export const cacheSet = async (key, value, ttlSeconds = 3600) => {
  await redis.set(key, JSON.stringify(value), 'EX', ttlSeconds);
};

export const cacheDel = async (key) => {
  await redis.del(key);
};

// Timeline cache (sorted sets for feed)
export const timelineAdd = async (userId, postId, timestamp) => {
  await redis.zadd(`timeline:${userId}`, timestamp, postId);
  // Keep only last 500 posts in timeline
  await redis.zremrangebyrank(`timeline:${userId}`, 0, -501);
};

export const timelineGet = async (userId, offset = 0, limit = 20) => {
  return redis.zrevrange(`timeline:${userId}`, offset, offset + limit - 1);
};

export const timelineRemove = async (userId, postId) => {
  await redis.zrem(`timeline:${userId}`, postId);
};

// Story tray cache
export const storyTraySet = async (userId, stories, ttlSeconds = 300) => {
  await redis.set(`story_tray:${userId}`, JSON.stringify(stories), 'EX', ttlSeconds);
};

export const storyTrayGet = async (userId) => {
  const data = await redis.get(`story_tray:${userId}`);
  return data ? JSON.parse(data) : null;
};

export default redis;
