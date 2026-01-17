/**
 * @fileoverview Redis client and caching utilities for the Ad Click Aggregator.
 * Provides deduplication, rate limiting, fraud detection tracking,
 * HyperLogLog-based unique user counting, and real-time click counters.
 * Redis is critical for sub-millisecond operations in the click ingestion path.
 */

import Redis from 'ioredis';

/**
 * Redis client configured from environment variables.
 * Uses lazy connection to avoid blocking startup.
 */
const redis = new Redis({
  host: process.env.REDIS_HOST || 'localhost',
  port: parseInt(process.env.REDIS_PORT || '6379'),
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

/** Deduplication TTL in seconds (5 minutes) - prevents duplicate click processing */
const DEDUP_TTL = 300;

/** Rate limiting window in seconds (1 minute) - for fraud detection thresholds */
const RATE_LIMIT_WINDOW = 60;

/**
 * Checks if a click has already been processed within the deduplication window.
 * Essential for exactly-once semantics in distributed click ingestion.
 *
 * @param clickId - Unique identifier for the click event
 * @returns True if click is a duplicate, false if new
 */
export async function isDuplicateClick(clickId: string): Promise<boolean> {
  const key = `click:dedup:${clickId}`;
  const exists = await redis.exists(key);
  return exists === 1;
}

/**
 * Marks a click as processed in Redis with TTL for deduplication.
 * Called after successful click ingestion to prevent reprocessing.
 *
 * @param clickId - Unique identifier for the click event
 */
export async function markClickProcessed(clickId: string): Promise<void> {
  const key = `click:dedup:${clickId}`;
  await redis.setex(key, DEDUP_TTL, '1');
}

/**
 * Implements sliding window rate limiting using Redis INCR.
 * Used to throttle requests and detect suspicious activity patterns.
 *
 * @param key - Unique identifier for the rate limit bucket (e.g., IP hash or user ID)
 * @param maxRequests - Maximum allowed requests within the window
 * @returns Object containing whether request is allowed and current count
 */
export async function checkRateLimit(key: string, maxRequests: number): Promise<{ allowed: boolean; count: number }> {
  const redisKey = `ratelimit:${key}`;
  const count = await redis.incr(redisKey);

  if (count === 1) {
    await redis.expire(redisKey, RATE_LIMIT_WINDOW);
  }

  return {
    allowed: count <= maxRequests,
    count,
  };
}

/**
 * Tracks click count per IP address for fraud detection velocity checks.
 * High click counts from a single IP indicate potential bot activity.
 *
 * @param ipHash - Hashed IP address (for privacy)
 * @returns Current click count for this IP in the current window
 */
export async function trackIpClicks(ipHash: string): Promise<number> {
  const key = `fraud:ip:${ipHash}`;
  const count = await redis.incr(key);

  if (count === 1) {
    await redis.expire(key, RATE_LIMIT_WINDOW);
  }

  return count;
}

/**
 * Tracks click count per user ID for fraud detection velocity checks.
 * High click counts from a single user indicate potential fraud or abuse.
 *
 * @param userId - Unique user identifier
 * @returns Current click count for this user in the current window
 */
export async function trackUserClicks(userId: string): Promise<number> {
  const key = `fraud:user:${userId}`;
  const count = await redis.incr(key);

  if (count === 1) {
    await redis.expire(key, RATE_LIMIT_WINDOW);
  }

  return count;
}

/**
 * Tracks unique users per ad using Redis HyperLogLog for memory-efficient cardinality estimation.
 * Provides approximate unique user counts with ~0.81% standard error.
 *
 * @param adId - Advertisement identifier
 * @param userId - User to track
 * @param timeBucket - Time bucket string for the aggregation period
 */
export async function trackUniqueUser(adId: string, userId: string, timeBucket: string): Promise<void> {
  const key = `hll:ad:${adId}:${timeBucket}`;
  await redis.pfadd(key, userId);
  // Set expiry to 2 hours for minute buckets
  await redis.expire(key, 7200);
}

/**
 * Retrieves estimated unique user count for an ad in a specific time bucket.
 * Uses HyperLogLog PFCOUNT for O(1) cardinality estimation.
 *
 * @param adId - Advertisement identifier
 * @param timeBucket - Time bucket string for the aggregation period
 * @returns Estimated count of unique users
 */
export async function getUniqueUserCount(adId: string, timeBucket: string): Promise<number> {
  const key = `hll:ad:${adId}:${timeBucket}`;
  return redis.pfcount(key);
}

/**
 * Atomically increments real-time click counters for dashboard display.
 * Updates counters at ad, campaign, and global levels using Redis pipelines.
 * Counters expire after 2 hours to prevent unbounded memory growth.
 *
 * @param adId - Advertisement identifier
 * @param campaignId - Campaign identifier
 * @param timeBucket - Time bucket string (minute granularity)
 */
export async function incrementRealTimeCounter(
  adId: string,
  campaignId: string,
  timeBucket: string
): Promise<void> {
  const multi = redis.multi();

  // Per-ad counter
  multi.hincrby(`realtime:ad:${adId}`, timeBucket, 1);
  multi.expire(`realtime:ad:${adId}`, 7200);

  // Per-campaign counter
  multi.hincrby(`realtime:campaign:${campaignId}`, timeBucket, 1);
  multi.expire(`realtime:campaign:${campaignId}`, 7200);

  // Global counter
  multi.hincrby('realtime:global', timeBucket, 1);
  multi.expire('realtime:global', 7200);

  await multi.exec();
}

/**
 * Retrieves real-time click counts for a specific ad across time buckets.
 * Returns a map of time bucket to click count.
 *
 * @param adId - Advertisement identifier
 * @returns Map of time bucket strings to click counts
 */
export async function getRealTimeAdClicks(adId: string): Promise<Record<string, number>> {
  const data = await redis.hgetall(`realtime:ad:${adId}`);
  const result: Record<string, number> = {};
  for (const [key, value] of Object.entries(data)) {
    result[key] = parseInt(value, 10);
  }
  return result;
}

/**
 * Get real-time click counts for a campaign
 */
export async function getRealTimeCampaignClicks(campaignId: string): Promise<Record<string, number>> {
  const data = await redis.hgetall(`realtime:campaign:${campaignId}`);
  const result: Record<string, number> = {};
  for (const [key, value] of Object.entries(data)) {
    result[key] = parseInt(value, 10);
  }
  return result;
}

/**
 * Get global real-time click counts
 */
export async function getRealTimeGlobalClicks(): Promise<Record<string, number>> {
  const data = await redis.hgetall('realtime:global');
  const result: Record<string, number> = {};
  for (const [key, value] of Object.entries(data)) {
    result[key] = parseInt(value, 10);
  }
  return result;
}

export async function testConnection(): Promise<boolean> {
  try {
    await redis.ping();
    return true;
  } catch (error) {
    console.error('Redis connection failed:', error);
    return false;
  }
}

export default redis;
