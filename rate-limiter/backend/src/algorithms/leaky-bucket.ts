// Leaky Bucket Algorithm
// Requests enter queue, processed at fixed rate
// Provides the smoothest output rate, prevents bursts entirely

import Redis from 'ioredis';
import { RateLimitResult } from '../types/index.js';
import { RateLimiter } from './base.js';

export interface LeakyBucketOptions {
  burstCapacity?: number;
  leakRate?: number; // requests per second that "leak" out
}

export class LeakyBucketLimiter implements RateLimiter {
  private redis: Redis;
  private keyPrefix: string;

  constructor(redis: Redis, keyPrefix: string = 'ratelimit:leaky:') {
    this.redis = redis;
    this.keyPrefix = keyPrefix;
  }

  async check(
    identifier: string,
    limit: number,
    windowSeconds: number,
    options: LeakyBucketOptions = {}
  ): Promise<RateLimitResult> {
    const bucketSize = options.burstCapacity || limit;
    // Default leak rate: empty bucket in windowSeconds
    const leakRate = options.leakRate || limit / windowSeconds;

    const now = Date.now();
    const key = `${this.keyPrefix}${identifier}`;

    // Lua script for atomic leaky bucket operations
    const luaScript = `
      local key = KEYS[1]
      local bucket_size = tonumber(ARGV[1])
      local leak_rate = tonumber(ARGV[2])
      local now = tonumber(ARGV[3])
      local expiry = tonumber(ARGV[4])

      -- Get current state
      local bucket = redis.call('HMGET', key, 'water', 'last_leak')
      local water = tonumber(bucket[1]) or 0
      local last_leak = tonumber(bucket[2]) or now

      -- Leak water based on time passed
      local elapsed = (now - last_leak) / 1000  -- convert to seconds
      local leaked = elapsed * leak_rate
      water = math.max(0, water - leaked)

      -- Try to add water (new request)
      if water < bucket_size then
        water = water + 1
        redis.call('HMSET', key, 'water', water, 'last_leak', now)
        redis.call('PEXPIRE', key, expiry)
        local remaining = math.floor(bucket_size - water)
        return {1, remaining, 0}  -- allowed, remaining, retry_after
      else
        -- Calculate time until space available
        local retry_after = (water - bucket_size + 1) / leak_rate
        return {0, 0, retry_after}  -- denied
      end
    `;

    const expiryMs = Math.ceil(bucketSize / leakRate * 1000) + 10000;

    const result = await this.redis.eval(
      luaScript,
      1,
      key,
      bucketSize.toString(),
      leakRate.toString(),
      now.toString(),
      expiryMs.toString()
    ) as [number, number, number];

    const allowed = result[0] === 1;
    const remaining = result[1];
    const retryAfterSec = result[2];

    // Reset time is when bucket would be empty
    const resetTime = now + (bucketSize / leakRate) * 1000;

    return {
      allowed,
      remaining: Math.max(0, remaining),
      limit: bucketSize,
      resetTime: Math.ceil(resetTime),
      retryAfter: allowed ? undefined : Math.max(1, Math.ceil(retryAfterSec)),
    };
  }

  async getState(
    identifier: string,
    limit: number,
    windowSeconds: number,
    options: LeakyBucketOptions = {}
  ): Promise<RateLimitResult> {
    const bucketSize = options.burstCapacity || limit;
    const leakRate = options.leakRate || limit / windowSeconds;

    const now = Date.now();
    const key = `${this.keyPrefix}${identifier}`;

    const bucket = await this.redis.hmget(key, 'water', 'last_leak');
    let water = parseFloat(bucket[0] || '0');
    const lastLeak = parseInt(bucket[1] || now.toString(), 10);

    // Leak water based on time passed
    const elapsed = (now - lastLeak) / 1000;
    water = Math.max(0, water - elapsed * leakRate);

    const remaining = Math.floor(bucketSize - water);
    const resetTime = now + (bucketSize / leakRate) * 1000;

    return {
      allowed: water < bucketSize,
      remaining: Math.max(0, remaining),
      limit: bucketSize,
      resetTime: Math.ceil(resetTime),
    };
  }

  async reset(identifier: string): Promise<void> {
    const key = `${this.keyPrefix}${identifier}`;
    await this.redis.del(key);
  }
}
