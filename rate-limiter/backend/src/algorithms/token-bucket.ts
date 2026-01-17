// Token Bucket Algorithm
// Allows controlled bursts, smooth rate limiting
// Bucket refills at constant rate, requests consume tokens

import Redis from 'ioredis';
import { RateLimitResult } from '../types/index.js';
import { RateLimiter } from './base.js';

export interface TokenBucketOptions {
  burstCapacity?: number;
  refillRate?: number; // tokens per second
}

export class TokenBucketLimiter implements RateLimiter {
  private redis: Redis;
  private keyPrefix: string;

  constructor(redis: Redis, keyPrefix: string = 'ratelimit:token:') {
    this.redis = redis;
    this.keyPrefix = keyPrefix;
  }

  async check(
    identifier: string,
    limit: number,
    windowSeconds: number,
    options: TokenBucketOptions = {}
  ): Promise<RateLimitResult> {
    const capacity = options.burstCapacity || limit;
    // Default refill rate: fill entire bucket in windowSeconds
    const refillRate = options.refillRate || limit / windowSeconds;

    const now = Date.now();
    const key = `${this.keyPrefix}${identifier}`;

    // Lua script for atomic token bucket operations
    const luaScript = `
      local key = KEYS[1]
      local capacity = tonumber(ARGV[1])
      local refill_rate = tonumber(ARGV[2])
      local now = tonumber(ARGV[3])
      local expiry = tonumber(ARGV[4])

      -- Get current state
      local bucket = redis.call('HMGET', key, 'tokens', 'last_refill')
      local tokens = tonumber(bucket[1])
      local last_refill = tonumber(bucket[2])

      -- Initialize if new bucket
      if tokens == nil then
        tokens = capacity
        last_refill = now
      end

      -- Calculate refill
      local elapsed = (now - last_refill) / 1000  -- convert to seconds
      local refill = elapsed * refill_rate
      tokens = math.min(capacity, tokens + refill)

      -- Try to consume token
      if tokens >= 1 then
        tokens = tokens - 1
        redis.call('HMSET', key, 'tokens', tokens, 'last_refill', now)
        redis.call('PEXPIRE', key, expiry)
        return {1, math.floor(tokens), 0}  -- allowed, remaining, retry_after
      else
        -- Calculate time until 1 token available
        local retry_after = (1 - tokens) / refill_rate
        return {0, 0, retry_after}  -- denied
      end
    `;

    const expiryMs = Math.ceil(capacity / refillRate * 1000) + 10000;

    const result = await this.redis.eval(
      luaScript,
      1,
      key,
      capacity.toString(),
      refillRate.toString(),
      now.toString(),
      expiryMs.toString()
    ) as [number, number, number];

    const allowed = result[0] === 1;
    const remaining = result[1];
    const retryAfterSec = result[2];

    // Reset time is when bucket would be full again
    const tokensNeeded = capacity - remaining;
    const resetTime = now + (tokensNeeded / refillRate) * 1000;

    return {
      allowed,
      remaining: Math.max(0, remaining),
      limit: capacity,
      resetTime: Math.ceil(resetTime),
      retryAfter: allowed ? undefined : Math.max(1, Math.ceil(retryAfterSec)),
    };
  }

  async getState(
    identifier: string,
    limit: number,
    windowSeconds: number,
    options: TokenBucketOptions = {}
  ): Promise<RateLimitResult> {
    const capacity = options.burstCapacity || limit;
    const refillRate = options.refillRate || limit / windowSeconds;

    const now = Date.now();
    const key = `${this.keyPrefix}${identifier}`;

    const bucket = await this.redis.hmget(key, 'tokens', 'last_refill');
    let tokens = parseFloat(bucket[0] || capacity.toString());
    const lastRefill = parseInt(bucket[1] || now.toString(), 10);

    // Calculate refill
    const elapsed = (now - lastRefill) / 1000;
    tokens = Math.min(capacity, tokens + elapsed * refillRate);

    const tokensNeeded = capacity - tokens;
    const resetTime = now + (tokensNeeded / refillRate) * 1000;

    return {
      allowed: tokens >= 1,
      remaining: Math.floor(tokens),
      limit: capacity,
      resetTime: Math.ceil(resetTime),
    };
  }

  async reset(identifier: string): Promise<void> {
    const key = `${this.keyPrefix}${identifier}`;
    await this.redis.del(key);
  }
}
