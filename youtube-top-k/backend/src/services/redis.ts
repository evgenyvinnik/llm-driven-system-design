import { createClient, RedisClientType } from 'redis';

let client: RedisClientType | null = null;

export async function getRedisClient(): Promise<RedisClientType> {
  if (!client) {
    client = createClient({
      url: process.env.REDIS_URL || 'redis://localhost:6379',
    });

    client.on('error', (err: Error) => console.error('Redis Client Error:', err));
    client.on('connect', () => console.log('Redis connected'));
    client.on('reconnecting', () => console.log('Redis reconnecting'));
  }

  if (!client.isOpen) {
    await client.connect();
  }

  return client;
}

export async function initializeRedis(): Promise<RedisClientType> {
  const redisClient = await getRedisClient();
  // Verify connection
  await redisClient.ping();
  console.log('Redis initialized successfully');
  return redisClient;
}

export interface TopKResult {
  videoId: string;
  viewCount: number;
}

/**
 * Windowed View Counter
 * Uses Redis sorted sets with time-based bucketing for efficient windowed counting
 */
export class WindowedViewCounter {
  private windowMinutes: number;
  private bucketMinutes: number;

  constructor(windowMinutes = 60, bucketMinutes = 1) {
    this.windowMinutes = windowMinutes;
    this.bucketMinutes = bucketMinutes;
  }

  /**
   * Get the current time bucket
   */
  getCurrentBucket(): number {
    const now = Date.now();
    return Math.floor(now / (this.bucketMinutes * 60 * 1000));
  }

  /**
   * Get the key for a specific time bucket
   */
  getBucketKey(bucket: number, category = 'all'): string {
    return `views:bucket:${category}:${bucket}`;
  }

  /**
   * Record a view for a video
   */
  async recordView(videoId: string, category = 'all'): Promise<void> {
    const redisClient = await getRedisClient();
    const bucket = this.getCurrentBucket();

    // Use pipeline for atomic operations
    const pipeline = redisClient.multi();

    // Increment view count in current bucket for 'all' category
    const allKey = this.getBucketKey(bucket, 'all');
    pipeline.zIncrBy(allKey, 1, videoId);
    pipeline.expire(allKey, (this.windowMinutes + 10) * 60);

    // Also increment in category-specific bucket
    if (category && category !== 'all') {
      const categoryKey = this.getBucketKey(bucket, category);
      pipeline.zIncrBy(categoryKey, 1, videoId);
      pipeline.expire(categoryKey, (this.windowMinutes + 10) * 60);
    }

    // Track total views in a simple counter
    pipeline.hIncrBy('views:total', videoId, 1);

    await pipeline.exec();
  }

  /**
   * Get aggregated view counts for a time window
   */
  async getWindowedCounts(category = 'all'): Promise<Map<string, number>> {
    const redisClient = await getRedisClient();
    const currentBucket = this.getCurrentBucket();
    const bucketsNeeded = Math.ceil(this.windowMinutes / this.bucketMinutes);

    // Collect all bucket keys within the window
    const bucketKeys: string[] = [];
    for (let i = 0; i < bucketsNeeded; i++) {
      const bucket = currentBucket - i;
      bucketKeys.push(this.getBucketKey(bucket, category));
    }

    // Use ZUNIONSTORE to aggregate counts from all buckets
    const tempKey = `temp:windowed:${category}:${Date.now()}`;

    if (bucketKeys.length === 1) {
      // Just copy the single bucket
      const counts = await redisClient.zRangeWithScores(bucketKeys[0], 0, -1, { REV: true });
      return new Map(counts.map(({ value, score }) => [value, score]));
    }

    // Aggregate multiple buckets
    await redisClient.zUnionStore(tempKey, bucketKeys);
    const counts = await redisClient.zRangeWithScores(tempKey, 0, -1, { REV: true });
    await redisClient.del(tempKey);

    return new Map(counts.map(({ value, score }) => [value, score]));
  }

  /**
   * Get top K videos by view count in the current window
   */
  async getTopK(k = 10, category = 'all'): Promise<TopKResult[]> {
    const redisClient = await getRedisClient();
    const currentBucket = this.getCurrentBucket();
    const bucketsNeeded = Math.ceil(this.windowMinutes / this.bucketMinutes);

    // Collect all bucket keys within the window
    const bucketKeys: string[] = [];
    for (let i = 0; i < bucketsNeeded; i++) {
      const bucket = currentBucket - i;
      bucketKeys.push(this.getBucketKey(bucket, category));
    }

    // Filter to only existing keys
    const existingKeys: string[] = [];
    for (const key of bucketKeys) {
      const exists = await redisClient.exists(key);
      if (exists) {
        existingKeys.push(key);
      }
    }

    if (existingKeys.length === 0) {
      return [];
    }

    // Aggregate and get top K
    const tempKey = `temp:topk:${category}:${Date.now()}`;

    if (existingKeys.length === 1) {
      const topVideos = await redisClient.zRangeWithScores(existingKeys[0], 0, k - 1, { REV: true });
      return topVideos.map(({ value, score }) => ({ videoId: value, viewCount: score }));
    }

    await redisClient.zUnionStore(tempKey, existingKeys);
    const topVideos = await redisClient.zRangeWithScores(tempKey, 0, k - 1, { REV: true });
    await redisClient.del(tempKey);

    return topVideos.map(({ value, score }) => ({ videoId: value, viewCount: score }));
  }

  /**
   * Get total view count for a video (all time)
   */
  async getTotalViews(videoId: string): Promise<number> {
    const redisClient = await getRedisClient();
    const count = await redisClient.hGet('views:total', videoId);
    return parseInt(count || '0', 10);
  }

  /**
   * Get view counts for multiple videos
   */
  async getMultipleTotalViews(videoIds: string[]): Promise<Map<string, number>> {
    const redisClient = await getRedisClient();
    const counts = await redisClient.hmGet('views:total', videoIds);
    return new Map(videoIds.map((id, i) => [id, parseInt(counts[i] || '0', 10)]));
  }
}
