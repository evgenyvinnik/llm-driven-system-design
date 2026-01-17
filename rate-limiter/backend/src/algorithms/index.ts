// Rate Limiter Factory and Index

import Redis from 'ioredis';
import { Algorithm, RateLimitResult } from '../types/index.js';
import { RateLimiter } from './base.js';
import { FixedWindowLimiter } from './fixed-window.js';
import { SlidingWindowLimiter } from './sliding-window.js';
import { SlidingLogLimiter } from './sliding-log.js';
import { TokenBucketLimiter, TokenBucketOptions } from './token-bucket.js';
import { LeakyBucketLimiter, LeakyBucketOptions } from './leaky-bucket.js';

export { RateLimiter } from './base.js';
export { FixedWindowLimiter } from './fixed-window.js';
export { SlidingWindowLimiter } from './sliding-window.js';
export { SlidingLogLimiter } from './sliding-log.js';
export { TokenBucketLimiter } from './token-bucket.js';
export { LeakyBucketLimiter } from './leaky-bucket.js';

export interface CheckOptions {
  burstCapacity?: number;
  refillRate?: number;
  leakRate?: number;
}

export class RateLimiterFactory {
  private fixedWindow: FixedWindowLimiter;
  private slidingWindow: SlidingWindowLimiter;
  private slidingLog: SlidingLogLimiter;
  private tokenBucket: TokenBucketLimiter;
  private leakyBucket: LeakyBucketLimiter;

  constructor(redis: Redis, keyPrefix: string = 'ratelimit:') {
    this.fixedWindow = new FixedWindowLimiter(redis, `${keyPrefix}fixed:`);
    this.slidingWindow = new SlidingWindowLimiter(redis, `${keyPrefix}sliding:`);
    this.slidingLog = new SlidingLogLimiter(redis, `${keyPrefix}log:`);
    this.tokenBucket = new TokenBucketLimiter(redis, `${keyPrefix}token:`);
    this.leakyBucket = new LeakyBucketLimiter(redis, `${keyPrefix}leaky:`);
  }

  getLimiter(algorithm: Algorithm): RateLimiter {
    switch (algorithm) {
      case 'fixed_window':
        return this.fixedWindow;
      case 'sliding_window':
        return this.slidingWindow;
      case 'sliding_log':
        return this.slidingLog;
      case 'token_bucket':
        return this.tokenBucket;
      case 'leaky_bucket':
        return this.leakyBucket;
      default:
        throw new Error(`Unknown algorithm: ${algorithm}`);
    }
  }

  async check(
    algorithm: Algorithm,
    identifier: string,
    limit: number,
    windowSeconds: number,
    options: CheckOptions = {}
  ): Promise<RateLimitResult> {
    const limiter = this.getLimiter(algorithm);
    return limiter.check(identifier, limit, windowSeconds, options);
  }

  async getState(
    algorithm: Algorithm,
    identifier: string,
    limit: number,
    windowSeconds: number,
    options: CheckOptions = {}
  ): Promise<RateLimitResult> {
    const limiter = this.getLimiter(algorithm);
    return limiter.getState(identifier, limit, windowSeconds, options);
  }

  async reset(algorithm: Algorithm, identifier: string): Promise<void> {
    const limiter = this.getLimiter(algorithm);
    return limiter.reset(identifier);
  }

  async resetAll(identifier: string): Promise<void> {
    await Promise.all([
      this.fixedWindow.reset(identifier),
      this.slidingWindow.reset(identifier),
      this.slidingLog.reset(identifier),
      this.tokenBucket.reset(identifier),
      this.leakyBucket.reset(identifier),
    ]);
  }
}
