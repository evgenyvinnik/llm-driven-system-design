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

// Distributed lock implementation with metrics
export const acquireLock = async (key, ttlSeconds = 5) => {
  const lockKey = `lock:${key}`;
  const lockValue = Date.now().toString();
  const startTime = Date.now();

  const acquired = await redis.set(lockKey, lockValue, 'EX', ttlSeconds, 'NX');

  if (acquired) {
    lockAcquireTotal.inc({ lock_name: key, status: 'acquired' });
    return { lockKey, lockValue, startTime };
  }
  lockAcquireTotal.inc({ lock_name: key, status: 'failed' });
  return null;
};

export const releaseLock = async (lock) => {
  if (!lock) return;

  // Record lock hold duration
  const holdDuration = (Date.now() - lock.startTime) / 1000;
  lockHoldDuration.observe({ lock_name: lock.lockKey.replace('lock:', '') }, holdDuration);

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
  await redis.del(`auction:bids:${auctionId}`);
};

// ============================================
// Idempotency Support for Bid Placement
// ============================================

/**
 * Check if a bid with this idempotency key has already been processed
 * @param {string} idempotencyKey - Unique key for the bid request
 * @returns {object|null} Cached bid result if exists, null otherwise
 */
export const getIdempotentBid = async (idempotencyKey) => {
  const key = `idempotent:bid:${idempotencyKey}`;
  const data = await redis.get(key);
  if (data) {
    cacheHitsTotal.inc({ cache_type: 'idempotent_bid' });
    return JSON.parse(data);
  }
  cacheMissesTotal.inc({ cache_type: 'idempotent_bid' });
  return null;
};

/**
 * Store a bid result with its idempotency key
 * @param {string} idempotencyKey - Unique key for the bid request
 * @param {object} bidResult - The bid result to cache
 * @param {number} ttlSeconds - Time to live in seconds (default 24 hours)
 */
export const setIdempotentBid = async (idempotencyKey, bidResult, ttlSeconds = 86400) => {
  const key = `idempotent:bid:${idempotencyKey}`;
  await redis.setex(key, ttlSeconds, JSON.stringify(bidResult));
};

/**
 * Mark an idempotency key as "in progress" to prevent duplicate concurrent requests
 * @param {string} idempotencyKey - Unique key for the bid request
 * @param {number} ttlSeconds - Time to live for the lock (default 30 seconds)
 * @returns {boolean} True if successfully marked, false if already in progress
 */
export const markBidInProgress = async (idempotencyKey, ttlSeconds = 30) => {
  const key = `idempotent:bid:progress:${idempotencyKey}`;
  const result = await redis.set(key, 'processing', 'EX', ttlSeconds, 'NX');
  return result !== null;
};

/**
 * Clear the in-progress marker for an idempotency key
 * @param {string} idempotencyKey - Unique key for the bid request
 */
export const clearBidInProgress = async (idempotencyKey) => {
  const key = `idempotent:bid:progress:${idempotencyKey}`;
  await redis.del(key);
};

// ============================================
// Enhanced Auction Caching
// ============================================

/**
 * Cache auction data with current bid info
 * @param {string} auctionId - Auction ID
 * @param {object} auctionData - Full auction data including current price
 * @param {number} ttlSeconds - Time to live (default 60 seconds)
 */
export const cacheAuctionWithBids = async (auctionId, auctionData, ttlSeconds = 60) => {
  const key = `auction:full:${auctionId}`;
  await redis.setex(key, ttlSeconds, JSON.stringify(auctionData));
};

/**
 * Get cached auction with bid info
 * @param {string} auctionId - Auction ID
 * @returns {object|null} Cached auction data or null
 */
export const getCachedAuctionWithBids = async (auctionId) => {
  const key = `auction:full:${auctionId}`;
  const data = await redis.get(key);
  if (data) {
    cacheHitsTotal.inc({ cache_type: 'auction_full' });
    return JSON.parse(data);
  }
  cacheMissesTotal.inc({ cache_type: 'auction_full' });
  return null;
};

/**
 * Cache the current highest bid for an auction (short TTL for real-time updates)
 * @param {string} auctionId - Auction ID
 * @param {object} bidInfo - Current bid info (amount, bidder_id, timestamp)
 * @param {number} ttlSeconds - Time to live (default 30 seconds)
 */
export const cacheCurrentBid = async (auctionId, bidInfo, ttlSeconds = 30) => {
  const key = `auction:current_bid:${auctionId}`;
  await redis.setex(key, ttlSeconds, JSON.stringify(bidInfo));
};

/**
 * Get cached current bid for an auction
 * @param {string} auctionId - Auction ID
 * @returns {object|null} Current bid info or null
 */
export const getCachedCurrentBid = async (auctionId) => {
  const key = `auction:current_bid:${auctionId}`;
  const data = await redis.get(key);
  if (data) {
    cacheHitsTotal.inc({ cache_type: 'current_bid' });
    return JSON.parse(data);
  }
  cacheMissesTotal.inc({ cache_type: 'current_bid' });
  return null;
};

/**
 * Cache bid history for an auction
 * @param {string} auctionId - Auction ID
 * @param {array} bids - Array of bid records
 * @param {number} ttlSeconds - Time to live (default 30 seconds)
 */
export const cacheBidHistory = async (auctionId, bids, ttlSeconds = 30) => {
  const key = `auction:bids:${auctionId}`;
  await redis.setex(key, ttlSeconds, JSON.stringify(bids));
};

/**
 * Get cached bid history for an auction
 * @param {string} auctionId - Auction ID
 * @returns {array|null} Array of bids or null
 */
export const getCachedBidHistory = async (auctionId) => {
  const key = `auction:bids:${auctionId}`;
  const data = await redis.get(key);
  if (data) {
    cacheHitsTotal.inc({ cache_type: 'bid_history' });
    return JSON.parse(data);
  }
  cacheMissesTotal.inc({ cache_type: 'bid_history' });
  return null;
};

// ============================================
// Rate Limiting
// ============================================

/**
 * Check and increment rate limit for a user action
 * @param {string} userId - User ID
 * @param {string} action - Action type (e.g., 'bid', 'create_auction')
 * @param {number} limit - Maximum allowed requests
 * @param {number} windowSeconds - Time window in seconds
 * @returns {object} { allowed: boolean, remaining: number, resetIn: number }
 */
export const checkRateLimit = async (userId, action, limit, windowSeconds) => {
  const key = `rate:${userId}:${action}`;

  const multi = redis.multi();
  multi.incr(key);
  multi.ttl(key);

  const results = await multi.exec();
  const count = results[0][1];
  let ttl = results[1][1];

  // Set expiry if this is the first request in the window
  if (ttl === -1) {
    await redis.expire(key, windowSeconds);
    ttl = windowSeconds;
  }

  return {
    allowed: count <= limit,
    remaining: Math.max(0, limit - count),
    resetIn: ttl,
  };
};

// ============================================
// Health Check
// ============================================

/**
 * Check Redis connection health
 * @returns {Promise<object>} Health status
 */
export const checkRedisHealth = async () => {
  try {
    const start = Date.now();
    await redis.ping();
    const latency = Date.now() - start;
    return {
      status: 'healthy',
      latency: `${latency}ms`,
    };
  } catch (error) {
    return {
      status: 'unhealthy',
      error: error.message,
    };
  }
};

export default redis;
