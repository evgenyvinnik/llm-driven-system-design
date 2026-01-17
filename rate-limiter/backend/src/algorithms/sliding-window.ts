// Sliding Window Counter Algorithm
// Combines current and previous window counts weighted by time position

import Redis from 'ioredis';
import { RateLimitResult } from '../types/index.js';
import { RateLimiter } from './base.js';

export class SlidingWindowLimiter implements RateLimiter {
  private redis: Redis;
  private keyPrefix: string;

  constructor(redis: Redis, keyPrefix: string = 'ratelimit:sliding:') {
    this.redis = redis;
    this.keyPrefix = keyPrefix;
  }

  async check(identifier: string, limit: number, windowSeconds: number): Promise<RateLimitResult> {
    const now = Date.now();
    const windowMs = windowSeconds * 1000;
    const currentWindow = Math.floor(now / windowMs);
    const previousWindow = currentWindow - 1;

    // Position within current window (0.0 to 1.0)
    const position = (now % windowMs) / windowMs;

    const currentKey = `${this.keyPrefix}${identifier}:${currentWindow}`;
    const previousKey = `${this.keyPrefix}${identifier}:${previousWindow}`;

    // Get both counts in a pipeline
    const pipeline = this.redis.pipeline();
    pipeline.get(currentKey);
    pipeline.get(previousKey);
    const results = await pipeline.exec();

    const currentCount = parseInt(results?.[0]?.[1] as string || '0', 10);
    const previousCount = parseInt(results?.[1]?.[1] as string || '0', 10);

    // Weighted count using sliding window formula
    const weightedCount = previousCount * (1 - position) + currentCount;

    const resetTime = (currentWindow + 1) * windowMs;

    if (weightedCount >= limit) {
      return {
        allowed: false,
        remaining: 0,
        limit,
        resetTime,
        retryAfter: Math.ceil((resetTime - now) / 1000),
      };
    }

    // Increment current window
    await this.redis.multi()
      .incr(currentKey)
      .pexpire(currentKey, windowMs * 2)
      .exec();

    return {
      allowed: true,
      remaining: Math.max(0, Math.floor(limit - weightedCount - 1)),
      limit,
      resetTime,
    };
  }

  async getState(identifier: string, limit: number, windowSeconds: number): Promise<RateLimitResult> {
    const now = Date.now();
    const windowMs = windowSeconds * 1000;
    const currentWindow = Math.floor(now / windowMs);
    const previousWindow = currentWindow - 1;
    const position = (now % windowMs) / windowMs;

    const currentKey = `${this.keyPrefix}${identifier}:${currentWindow}`;
    const previousKey = `${this.keyPrefix}${identifier}:${previousWindow}`;

    const pipeline = this.redis.pipeline();
    pipeline.get(currentKey);
    pipeline.get(previousKey);
    const results = await pipeline.exec();

    const currentCount = parseInt(results?.[0]?.[1] as string || '0', 10);
    const previousCount = parseInt(results?.[1]?.[1] as string || '0', 10);
    const weightedCount = previousCount * (1 - position) + currentCount;

    const resetTime = (currentWindow + 1) * windowMs;

    return {
      allowed: weightedCount < limit,
      remaining: Math.max(0, Math.floor(limit - weightedCount)),
      limit,
      resetTime,
    };
  }

  async reset(identifier: string): Promise<void> {
    const pattern = `${this.keyPrefix}${identifier}:*`;
    const keys = await this.redis.keys(pattern);
    if (keys.length > 0) {
      await this.redis.del(...keys);
    }
  }
}
