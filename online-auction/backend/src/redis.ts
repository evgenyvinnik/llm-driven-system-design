import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { lockAcquireTotal, lockHoldDuration, cacheHitsTotal, cacheMissesTotal } from './shared/metrics.js';
import { interpretIdempotencyRecord, type IdempotencyLookup } from './shared/idempotency.js';
import type { Lock, RateLimitResult, HealthStatus, Bid, CurrentBidInfo, Auction } from './types.js';

const redis = new Redis({
  host: process.env.REDIS_HOST || 'localhost',
  port: parseInt(process.env.REDIS_PORT || '6379'),
  retryStrategy: (times: number) => Math.min(times * 100, 3000),
  maxRetriesPerRequest: 3,
});

redis.on('error', (err: Error) => {
  console.error('Redis connection error:', err);
});

redis.on('connect', () => {
  console.log('Connected to Redis');
});

// Distributed lock implementation with metrics
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Metric label for a lock key: `auction:<uuid>` -> `auction`, so label cardinality stays bounded. */
const lockName = (key: string): string => key.split(':')[0];

/**
 * Acquires a distributed lock with SET NX. With `waitMs > 0` it polls (10-40 ms
 * with jitter) until the deadline instead of failing on the first collision, so
 * a burst of bids on one auction queues briefly in Redis rather than holding
 * pooled database connections while blocked on the row lock.
 */
export const acquireLock = async (key: string, ttlSeconds: number = 5, waitMs: number = 0): Promise<Lock | null> => {
  const lockKey = `lock:${key}`;
  const lockValue = randomUUID();
  const deadline = Date.now() + waitMs;

  for (;;) {
    const acquired = await redis.set(lockKey, lockValue, 'EX', ttlSeconds, 'NX');
    if (acquired) {
      lockAcquireTotal.inc({ lock_name: lockName(key), status: 'acquired' });
      return { lockKey, lockValue, startTime: Date.now() };
    }
    if (Date.now() >= deadline) break;
    await sleep(10 + Math.random() * 30);
  }
  lockAcquireTotal.inc({ lock_name: lockName(key), status: 'failed' });
  return null;
};

/** Releases a distributed lock using a Lua CAS script to prevent accidental deletion. */
export const releaseLock = async (lock: Lock | null): Promise<void> => {
  if (!lock) return;

  // Record lock hold duration
  const holdDuration = (Date.now() - lock.startTime) / 1000;
  lockHoldDuration.observe({ lock_name: lockName(lock.lockKey.replace('lock:', '')) }, holdDuration);

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

/** Publishes a bid update to the auction's Redis pub/sub channel. */
export const publishBidUpdate = async (auctionId: string, data: unknown): Promise<void> => {
  await publisher.publish(`auction:${auctionId}`, JSON.stringify(data));
};

// Auction endings sorted set
/** Adds an auction to the sorted set of scheduled endings by timestamp. */
export const scheduleAuctionEnd = async (auctionId: string, endTime: Date | string): Promise<void> => {
  const timestamp = new Date(endTime).getTime();
  await redis.zadd('auction_endings', timestamp, auctionId);
};

/** Removes an auction from the scheduled endings sorted set. */
export const removeAuctionFromSchedule = async (auctionId: string): Promise<void> => {
  await redis.zrem('auction_endings', auctionId);
};

/** Returns up to `limit` auction IDs whose end times are at or before the given timestamp. */
export const getEndingAuctions = async (beforeTimestamp: number, limit: number = 100): Promise<string[]> => {
  return redis.zrangebyscore('auction_endings', '-inf', beforeTimestamp, 'LIMIT', 0, limit);
};

/**
 * Claims a due auction by removing it from the sorted set. ZREM returns 1 to
 * exactly one caller, so with several API instances only one attempts each
 * close. Correctness does not depend on this (the close re-checks the row
 * under FOR UPDATE); it only avoids duplicate work.
 */
export const claimAuctionEnd = async (auctionId: string): Promise<boolean> => {
  return (await redis.zrem('auction_endings', auctionId)) === 1;
};

/** Bulk ZADD used by the reconciler that rebuilds the schedule from PostgreSQL. */
export const scheduleAuctionEnds = async (entries: Array<{ id: string; end_time: Date | string }>): Promise<void> => {
  if (entries.length === 0) return;
  const args = entries.flatMap((e) => [new Date(e.end_time).getTime(), e.id]);
  await redis.zadd('auction_endings', ...args);
};

// Session management
/** Stores a user session token in Redis with a TTL. */
export const setSession = async (token: string, userId: string, ttlSeconds: number = 86400): Promise<void> => {
  await redis.setex(`session:${token}`, ttlSeconds, userId);
};

/** Retrieves the user ID associated with a session token. */
export const getSession = async (token: string): Promise<string | null> => {
  return redis.get(`session:${token}`);
};

/** Deletes a session token from Redis. */
export const deleteSession = async (token: string): Promise<void> => {
  await redis.del(`session:${token}`);
};

// Cache for auction data
/** Caches auction data in Redis with a TTL. */
export const cacheAuction = async (auctionId: string, data: Auction, ttlSeconds: number = 60): Promise<void> => {
  await redis.setex(`auction:cache:${auctionId}`, ttlSeconds, JSON.stringify(data));
};

/** Retrieves cached auction data, returning null on miss. */
export const getCachedAuction = async (auctionId: string): Promise<Auction | null> => {
  const data = await redis.get(`auction:cache:${auctionId}`);
  return data ? JSON.parse(data) : null;
};

/** Invalidates all cached data for an auction (full data, bids, current bid). */
export const invalidateAuctionCache = async (auctionId: string): Promise<void> => {
  await redis.del(`auction:cache:${auctionId}`);
  await redis.del(`auction:bids:${auctionId}`);
};

// ============================================
// Idempotency Support for Bid Placement
// ============================================

const idempotencyKey = (scope: string, key: string): string => `idempotency:bid:${scope}:${key}`;

/**
 * Claims a client's Idempotency-Key (scoped to the user, so two users can never
 * see each other's responses). The first request gets `claimed`; later ones get
 * the stored response, `in_flight` while the first is still running, or
 * `mismatch` if the same key arrives with a different body.
 */
export const claimIdempotencyKey = async (
  scope: string,
  key: string,
  fingerprint: string,
  ttlSeconds: number = 60
): Promise<{ state: 'claimed' } | IdempotencyLookup> => {
  const redisKey = idempotencyKey(scope, key);
  const claimed = await redis.set(redisKey, JSON.stringify({ state: 'pending', fingerprint }), 'EX', ttlSeconds, 'NX');
  if (claimed) return { state: 'claimed' };
  return interpretIdempotencyRecord(await redis.get(redisKey), fingerprint);
};

/** Stores the committed response under the key for replay (24 h). */
export const completeIdempotencyKey = async (
  scope: string,
  key: string,
  fingerprint: string,
  status: number,
  body: unknown,
  ttlSeconds: number = 86400
): Promise<void> => {
  await redis.set(idempotencyKey(scope, key), JSON.stringify({ state: 'done', fingerprint, status, body }), 'EX', ttlSeconds);
};

/** Drops a claim whose request failed, so the client can retry with the same key. */
export const releaseIdempotencyKey = async (scope: string, key: string): Promise<void> => {
  await redis.del(idempotencyKey(scope, key));
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

// INCR and the first EXPIRE in one atomic step: a crash between the two used to
// leave a counter without a TTL, blocking that user forever.
const RATE_LIMIT_SCRIPT = `
  local count = redis.call('INCR', KEYS[1])
  if count == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
  return {count, redis.call('TTL', KEYS[1])}
`;

/**
 * Check and increment a fixed-window rate limit for a user action
 */
export const checkRateLimit = async (
  userId: string,
  action: string,
  limit: number,
  windowSeconds: number
): Promise<RateLimitResult> => {
  const [count, ttl] = (await redis.eval(RATE_LIMIT_SCRIPT, 1, `rate:${userId}:${action}`, windowSeconds)) as [
    number,
    number,
  ];
  return {
    allowed: count <= limit,
    remaining: Math.max(0, limit - count),
    resetIn: ttl > 0 ? ttl : windowSeconds,
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
