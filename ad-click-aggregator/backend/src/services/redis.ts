import Redis from 'ioredis';

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

// Deduplication TTL in seconds (5 minutes)
const DEDUP_TTL = 300;

// Rate limiting window in seconds (1 minute)
const RATE_LIMIT_WINDOW = 60;

/**
 * Check if a click has already been processed (for deduplication)
 * Returns true if click is a duplicate
 */
export async function isDuplicateClick(clickId: string): Promise<boolean> {
  const key = `click:dedup:${clickId}`;
  const exists = await redis.exists(key);
  return exists === 1;
}

/**
 * Mark a click as processed (for deduplication)
 */
export async function markClickProcessed(clickId: string): Promise<void> {
  const key = `click:dedup:${clickId}`;
  await redis.setex(key, DEDUP_TTL, '1');
}

/**
 * Check and increment rate limit for IP or user
 * Returns current count
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
 * Track clicks per IP for fraud detection
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
 * Track clicks per user for fraud detection
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
 * Track unique users per ad for HyperLogLog estimation
 */
export async function trackUniqueUser(adId: string, userId: string, timeBucket: string): Promise<void> {
  const key = `hll:ad:${adId}:${timeBucket}`;
  await redis.pfadd(key, userId);
  // Set expiry to 2 hours for minute buckets
  await redis.expire(key, 7200);
}

/**
 * Get estimated unique users for an ad in a time bucket
 */
export async function getUniqueUserCount(adId: string, timeBucket: string): Promise<number> {
  const key = `hll:ad:${adId}:${timeBucket}`;
  return redis.pfcount(key);
}

/**
 * Store real-time click counts in Redis for fast dashboard access
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
 * Get real-time click counts for an ad
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
