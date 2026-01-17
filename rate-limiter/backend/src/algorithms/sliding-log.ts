// Sliding Window Log Algorithm
// Stores timestamp of each request, counts requests in sliding window
// Most accurate but memory-intensive

import Redis from 'ioredis';
import { RateLimitResult } from '../types/index.js';
import { RateLimiter } from './base.js';

export class SlidingLogLimiter implements RateLimiter {
  private redis: Redis;
  private keyPrefix: string;

  constructor(redis: Redis, keyPrefix: string = 'ratelimit:log:') {
    this.redis = redis;
    this.keyPrefix = keyPrefix;
  }

  async check(identifier: string, limit: number, windowSeconds: number): Promise<RateLimitResult> {
    const now = Date.now();
    const windowStart = now - windowSeconds * 1000;
    const key = `${this.keyPrefix}${identifier}`;

    // Use Lua script for atomic operations
    const luaScript = `
      local key = KEYS[1]
      local now = tonumber(ARGV[1])
      local window_start = tonumber(ARGV[2])
      local limit = tonumber(ARGV[3])
      local window_seconds = tonumber(ARGV[4])

      -- Remove expired entries
      redis.call('ZREMRANGEBYSCORE', key, 0, window_start)

      -- Get current count
      local count = redis.call('ZCARD', key)

      if count >= limit then
        -- Get oldest entry to calculate retry time
        local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
        local retry_after = 0
        if oldest[2] then
          retry_after = (tonumber(oldest[2]) + window_seconds * 1000 - now) / 1000
        end
        return {0, 0, retry_after}
      end

      -- Add new entry
      redis.call('ZADD', key, now, now .. ':' .. math.random())
      redis.call('PEXPIRE', key, window_seconds * 1000 + 1000)

      return {1, limit - count - 1, 0}
    `;

    const result = await this.redis.eval(
      luaScript,
      1,
      key,
      now.toString(),
      windowStart.toString(),
      limit.toString(),
      windowSeconds.toString()
    ) as [number, number, number];

    const allowed = result[0] === 1;
    const remaining = result[1];
    const retryAfter = result[2];

    return {
      allowed,
      remaining: Math.max(0, remaining),
      limit,
      resetTime: now + windowSeconds * 1000,
      retryAfter: allowed ? undefined : Math.max(1, Math.ceil(retryAfter)),
    };
  }

  async getState(identifier: string, limit: number, windowSeconds: number): Promise<RateLimitResult> {
    const now = Date.now();
    const windowStart = now - windowSeconds * 1000;
    const key = `${this.keyPrefix}${identifier}`;

    // Remove expired and count
    await this.redis.zremrangebyscore(key, 0, windowStart);
    const count = await this.redis.zcard(key);

    return {
      allowed: count < limit,
      remaining: Math.max(0, limit - count),
      limit,
      resetTime: now + windowSeconds * 1000,
    };
  }

  async reset(identifier: string): Promise<void> {
    const key = `${this.keyPrefix}${identifier}`;
    await this.redis.del(key);
  }
}
