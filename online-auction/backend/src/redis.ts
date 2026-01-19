import Redis from 'ioredis';
import { lockAcquireTotal, lockHoldDuration, cacheHitsTotal, cacheMissesTotal } from './shared/metrics.js';
import type { Lock, RateLimitResult, HealthStatus, Bid, CurrentBidInfo, IdempotentBidResult, Auction } from './types.js';

const redis = new Redis({
  host: process.env.REDIS_HOST || 'localhost',
  port: parseInt(process.env.REDIS_PORT || '6379'),
  retryDelayOnFailover: 100,
  maxRetriesPerRequest: 3,
});

redis.on('error', (err: Error) => {
  console.error('Redis connection error:', err);
});

redis.on('connect', () => {
  console.log('Connected to Redis');
});

// Distributed lock implementation with metrics
export const acquireLock = async (key: string, ttlSeconds: number = 5): Promise<Lock | null> => {
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

export const releaseLock = async (lock: Lock | null): Promise<void> => {
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

export const publishBidUpdate = async (auctionId: string, data: unknown): Promise<void> => {
  await publisher.publish(`auction:${auctionId}`, JSON.stringify(data));
};

// Auction endings sorted set
export const scheduleAuctionEnd = async (auctionId: string, endTime: Date | string): Promise<void> => {
  const timestamp = new Date(endTime).getTime();
  await redis.zadd('auction_endings', timestamp, auctionId);
};

export const removeAuctionFromSchedule = async (auctionId: string): Promise<void> => {
  await redis.zrem('auction_endings', auctionId);
};

export const getEndingAuctions = async (beforeTimestamp: number): Promise<string[]> => {
  return redis.zrangebyscore('auction_endings', 0, beforeTimestamp);
};

// Session management
export const setSession = async (token: string, userId: string, ttlSeconds: number = 86400): Promise<void> => {
  await redis.setex(`session:${token}`, ttlSeconds, userId);
};

export const getSession = async (token: string): Promise<string | null> => {
  return redis.get(`session:${token}`);
};

export const deleteSession = async (token: string): Promise<void> => {
  await redis.del(`session:${token}`);
};

// Cache for auction data
export const cacheAuction = async (auctionId: string, data: Auction, ttlSeconds: number = 60): Promise<void> => {
  await redis.setex(`auction:cache:${auctionId}`, ttlSeconds, JSON.stringify(data));
};

export const getCachedAuction = async (auctionId: string): Promise<Auction | null> => {
  const data = await redis.get(`auction:cache:${auctionId}`);
  return data ? JSON.parse(data) : null;
};

export const invalidateAuctionCache = async (auctionId: string): Promise<void> => {
  await redis.del(`auction:cache:${auctionId}`);
  await redis.del(`auction:bids:${auctionId}`);
};

// ============================================
// Idempotency Support for Bid Placement
// ============================================

/**
 * Check if a bid with this idempotency key has already been processed
 */
export const getIdempotentBid = async (idempotencyKey: string): Promise<IdempotentBidResult | null> => {
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
 */
export const setIdempotentBid = async (
  idempotencyKey: string,
  bidResult: IdempotentBidResult,
  ttlSeconds: number = 86400
): Promise<void> => {
  const key = `idempotent:bid:${idempotencyKey}`;
  await redis.setex(key, ttlSeconds, JSON.stringify(bidResult));
};

/**
 * Mark an idempotency key as "in progress" to prevent duplicate concurrent requests
 */
export const markBidInProgress = async (idempotencyKey: string, ttlSeconds: number = 30): Promise<boolean> => {
  const key = `idempotent:bid:progress:${idempotencyKey}`;
  const result = await redis.set(key, 'processing', 'EX', ttlSeconds, 'NX');
  return result !== null;
};

/**
 * Clear the in-progress marker for an idempotency key
 */
export const clearBidInProgress = async (idempotencyKey: string): Promise<void> => {
  const key = `idempotent:bid:progress:${idempotencyKey}`;
  await redis.del(key);
};

// ============================================
// Enhanced Auction Caching
// ============================================

/**
 * Cache auction data with current bid info
 */
export const cacheAuctionWithBids = async (
  auctionId: string,
  auctionData: unknown,
  ttlSeconds: number = 60
): Promise<void> => {
  const key = `auction:full:${auctionId}`;
  await redis.setex(key, ttlSeconds, JSON.stringify(auctionData));
};

/**
 * Get cached auction with bid info
 */
export const getCachedAuctionWithBids = async (auctionId: string): Promise<unknown | null> => {
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
 */
export const cacheCurrentBid = async (
  auctionId: string,
  bidInfo: CurrentBidInfo,
  ttlSeconds: number = 30
): Promise<void> => {
  const key = `auction:current_bid:${auctionId}`;
  await redis.setex(key, ttlSeconds, JSON.stringify(bidInfo));
};

/**
 * Get cached current bid for an auction
 */
export const getCachedCurrentBid = async (auctionId: string): Promise<CurrentBidInfo | null> => {
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
 */
export const cacheBidHistory = async (auctionId: string, bids: Bid[], ttlSeconds: number = 30): Promise<void> => {
  const key = `auction:bids:${auctionId}`;
  await redis.setex(key, ttlSeconds, JSON.stringify(bids));
};

/**
 * Get cached bid history for an auction
 */
export const getCachedBidHistory = async (auctionId: string): Promise<Bid[] | null> => {
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
 */
export const checkRateLimit = async (
  userId: string,
  action: string,
  limit: number,
  windowSeconds: number
): Promise<RateLimitResult> => {
  const key = `rate:${userId}:${action}`;

  const multi = redis.multi();
  multi.incr(key);
  multi.ttl(key);

  const results = await multi.exec();
  if (!results) {
    return { allowed: false, remaining: 0, resetIn: windowSeconds };
  }

  const count = results[0][1] as number;
  let ttl = results[1][1] as number;

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
 */
export const checkRedisHealth = async (): Promise<HealthStatus> => {
  try {
    const start = Date.now();
    await redis.ping();
    const latency = Date.now() - start;
    return {
      status: 'healthy',
      latency: `${latency}ms`,
    };
  } catch (error) {
    const err = error as Error;
    return {
      status: 'unhealthy',
      error: err.message,
    };
  }
};

export default redis;
