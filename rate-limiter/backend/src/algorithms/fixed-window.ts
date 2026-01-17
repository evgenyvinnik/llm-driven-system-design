/**
 * @fileoverview Fixed Window Counter Rate Limiting Algorithm.
 *
 * This is the simplest rate limiting algorithm. It divides time into fixed windows
 * (e.g., 60-second intervals) and counts requests within each window.
 *
 * Trade-offs:
 * - Pros: Simple to implement, memory efficient (one counter per window)
 * - Cons: Can allow up to 2x the limit at window boundaries (burst issue)
 *
 * Example: With a 10 req/min limit, a user could send 10 requests at 11:59:59
 * and 10 more at 12:00:01, effectively getting 20 requests in 2 seconds.
 */

import Redis from 'ioredis';
import { RateLimitResult } from '../types/index.js';
import { RateLimiter } from './base.js';

/**
 * Fixed Window rate limiter implementation.
 * Uses Redis INCR for atomic counter operations with TTL-based cleanup.
 */
export class FixedWindowLimiter implements RateLimiter {
  private redis: Redis;
  private keyPrefix: string;

  /**
   * Creates a new Fixed Window rate limiter.
   *
   * @param redis - Redis client instance for distributed state storage
   * @param keyPrefix - Prefix for Redis keys to avoid collisions
   */
  constructor(redis: Redis, keyPrefix: string = 'ratelimit:fixed:') {
    this.redis = redis;
    this.keyPrefix = keyPrefix;
  }

  /**
   * Check if a request is allowed and increment the counter atomically.
   * Uses Redis INCR for atomic increment, ensuring correctness under concurrency.
   *
   * @param identifier - Unique ID for the rate limit subject
   * @param limit - Maximum requests allowed per window
   * @param windowSeconds - Window duration in seconds
   * @returns Rate limit result indicating if request is allowed
   */
  async check(identifier: string, limit: number, windowSeconds: number): Promise<RateLimitResult> {
    const now = Date.now();
    // Calculate the start of the current window (aligned to windowSeconds)
    const windowStart = Math.floor(now / (windowSeconds * 1000)) * (windowSeconds * 1000);
    const key = `${this.keyPrefix}${identifier}:${windowStart}`;

    // Atomic increment
    const current = await this.redis.incr(key);

    // Set expiry if this is a new key (first request in window)
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

  /**
   * Get current window state without consuming a request slot.
   *
   * @param identifier - Unique ID for the rate limit subject
   * @param limit - Maximum requests allowed per window
   * @param windowSeconds - Window duration in seconds
   * @returns Current rate limit state
   */
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

  /**
   * Reset rate limit state by deleting all keys for the identifier.
   *
   * @param identifier - Unique ID to reset
   */
  async reset(identifier: string): Promise<void> {
    const pattern = `${this.keyPrefix}${identifier}:*`;
    const keys = await this.redis.keys(pattern);
    if (keys.length > 0) {
      await this.redis.del(...keys);
    }
  }
}
