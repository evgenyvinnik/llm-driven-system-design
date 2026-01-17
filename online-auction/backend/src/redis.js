import Redis from 'ioredis';
import { lockAcquireTotal, lockHoldDuration, cacheHitsTotal, cacheMissesTotal } from './shared/metrics.js';

const redis = new Redis({
  host: process.env.REDIS_HOST || 'localhost',
  port: parseInt(process.env.REDIS_PORT || '6379'),
  retryDelayOnFailover: 100,
  maxRetriesPerRequest: 3,
});

redis.on('error', (err) => {
  console.error('Redis connection error:', err);
});

redis.on('connect', () => {
  console.log('Connected to Redis');
});

// Distributed lock implementation
export const acquireLock = async (key, ttlSeconds = 5) => {
  const lockKey = `lock:${key}`;
  const lockValue = Date.now().toString();

  const acquired = await redis.set(lockKey, lockValue, 'EX', ttlSeconds, 'NX');

  if (acquired) {
    return { lockKey, lockValue };
  }
  return null;
};

export const releaseLock = async (lock) => {
  if (!lock) return;

  const script = `
    if redis.call("get", KEYS[1]) == ARGV[1] then
      return redis.call("del", KEYS[1])
    else
      return 0
    end
  `;

  await redis.eval(script, 1, lock.lockKey, lock.lockValue);
};

// Pub/Sub for real-time updates
export const publisher = redis.duplicate();
export const subscriber = redis.duplicate();

export const publishBidUpdate = async (auctionId, data) => {
  await publisher.publish(`auction:${auctionId}`, JSON.stringify(data));
};

// Auction endings sorted set
export const scheduleAuctionEnd = async (auctionId, endTime) => {
  const timestamp = new Date(endTime).getTime();
  await redis.zadd('auction_endings', timestamp, auctionId);
};

export const removeAuctionFromSchedule = async (auctionId) => {
  await redis.zrem('auction_endings', auctionId);
};

export const getEndingAuctions = async (beforeTimestamp) => {
  return redis.zrangebyscore('auction_endings', 0, beforeTimestamp);
};

// Session management
export const setSession = async (token, userId, ttlSeconds = 86400) => {
  await redis.setex(`session:${token}`, ttlSeconds, userId);
};

export const getSession = async (token) => {
  return redis.get(`session:${token}`);
};

export const deleteSession = async (token) => {
  await redis.del(`session:${token}`);
};

// Cache for auction data
export const cacheAuction = async (auctionId, data, ttlSeconds = 60) => {
  await redis.setex(`auction:cache:${auctionId}`, ttlSeconds, JSON.stringify(data));
};

export const getCachedAuction = async (auctionId) => {
  const data = await redis.get(`auction:cache:${auctionId}`);
  return data ? JSON.parse(data) : null;
};

export const invalidateAuctionCache = async (auctionId) => {
  await redis.del(`auction:cache:${auctionId}`);
};

export default redis;
