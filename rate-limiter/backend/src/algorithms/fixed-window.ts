// Fixed Window Counter Algorithm
// Simple counter that resets at fixed time boundaries

import Redis from 'ioredis';
import { RateLimitResult } from '../types/index.js';
import { RateLimiter } from './base.js';

export class FixedWindowLimiter implements RateLimiter {
  private redis: Redis;
  private keyPrefix: string;

  constructor(redis: Redis, keyPrefix: string = 'ratelimit:fixed:') {
    this.redis = redis;
    this.keyPrefix = keyPrefix;
  }

  async check(identifier: string, limit: number, windowSeconds: number): Promise<RateLimitResult> {
    const now = Date.now();
    const windowStart = Math.floor(now / (windowSeconds * 1000)) * (windowSeconds * 1000);
    const key = `${this.keyPrefix}${identifier}:${windowStart}`;

    // Atomic increment
    const current = await this.redis.incr(key);

    // Set expiry if this is a new key
    if (current === 1) {
      await this.redis.pexpire(key, windowSeconds * 1000 + 1000);
    }

    const resetTime = windowStart + windowSeconds * 1000;
    const remaining = Math.max(0, limit - current);
    const allowed = current <= limit;

    return {
      allowed,
      remaining,
      limit,
      resetTime,
      retryAfter: allowed ? undefined : Math.ceil((resetTime - now) / 1000),
    };
  }

  async getState(identifier: string, limit: number, windowSeconds: number): Promise<RateLimitResult> {
    const now = Date.now();
    const windowStart = Math.floor(now / (windowSeconds * 1000)) * (windowSeconds * 1000);
    const key = `${this.keyPrefix}${identifier}:${windowStart}`;

    const current = parseInt(await this.redis.get(key) || '0', 10);
    const resetTime = windowStart + windowSeconds * 1000;
    const remaining = Math.max(0, limit - current);

    return {
      allowed: current < limit,
      remaining,
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
