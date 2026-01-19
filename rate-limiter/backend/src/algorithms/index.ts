/**
 * @fileoverview Rate Limiter Factory and Algorithm Exports.
 *
 * This module provides a unified interface for working with all rate limiting algorithms.
 * The RateLimiterFactory creates and manages instances of each algorithm, allowing
 * callers to switch between algorithms without changing their code.
 */

import Redis from 'ioredis';
import { Algorithm, RateLimitResult } from '../types/index.js';
import { RateLimiter } from './base.js';
import { FixedWindowLimiter } from './fixed-window.js';
import { SlidingWindowLimiter } from './sliding-window.js';
import { SlidingLogLimiter } from './sliding-log.js';
import { TokenBucketLimiter, TokenBucketOptions } from './token-bucket.js';
import { LeakyBucketLimiter, LeakyBucketOptions } from './leaky-bucket.js';

// Re-export all algorithm classes for direct usage
export { RateLimiter, RateLimiterOptions } from './base.js';
export { FixedWindowLimiter } from './fixed-window.js';
export { SlidingWindowLimiter } from './sliding-window.js';
export { SlidingLogLimiter } from './sliding-log.js';
export { TokenBucketLimiter } from './token-bucket.js';
export { LeakyBucketLimiter } from './leaky-bucket.js';

/**
 * Options for rate limit check operations.
 * Extends base options with all bucket-based algorithm parameters.
 */
export interface CheckOptions {
  /** Bucket capacity for token/leaky bucket algorithms */
  burstCapacity?: number;
  /** Token refill rate for token bucket (tokens/second) */
  refillRate?: number;
  /** Leak rate for leaky bucket (requests/second) */
  leakRate?: number;
  /** Additional algorithm-specific options */
  [key: string]: unknown;
}

/**
 * Factory class for creating and managing rate limiter instances.
 * Provides a unified API for all rate limiting algorithms, making it easy
 * to switch between algorithms or use different algorithms for different use cases.
 *
 * All algorithm instances share the same Redis connection but use different key prefixes.
 */
export class RateLimiterFactory {
  private fixedWindow: FixedWindowLimiter;
  private slidingWindow: SlidingWindowLimiter;
  private slidingLog: SlidingLogLimiter;
  private tokenBucket: TokenBucketLimiter;
  private leakyBucket: LeakyBucketLimiter;

  /**
   * Creates a new RateLimiterFactory with instances of all algorithms.
   *
   * @param redis - Redis client instance shared by all algorithm implementations
   * @param keyPrefix - Base prefix for Redis keys (each algorithm adds its own suffix)
   */
  constructor(redis: Redis, keyPrefix: string = 'ratelimit:') {
    this.fixedWindow = new FixedWindowLimiter(redis, `${keyPrefix}fixed:`);
    this.slidingWindow = new SlidingWindowLimiter(redis, `${keyPrefix}sliding:`);
    this.slidingLog = new SlidingLogLimiter(redis, `${keyPrefix}log:`);
    this.tokenBucket = new TokenBucketLimiter(redis, `${keyPrefix}token:`);
    this.leakyBucket = new LeakyBucketLimiter(redis, `${keyPrefix}leaky:`);
  }

  /**
   * Get the rate limiter instance for a specific algorithm.
   *
   * @param algorithm - The algorithm type to retrieve
   * @returns The corresponding RateLimiter instance
   * @throws Error if the algorithm is unknown
   */
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

  /**
   * Check if a request is allowed using the specified algorithm.
   * This is the main entry point for rate limiting checks.
   *
   * @param algorithm - Which rate limiting algorithm to use
   * @param identifier - Unique ID for the rate limit subject
   * @param limit - Maximum requests allowed
   * @param windowSeconds - Time window in seconds
   * @param options - Algorithm-specific options
   * @returns Rate limit result with allowed status and metadata
   */
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

  /**
   * Get current rate limit state without consuming a request.
   *
   * @param algorithm - Which rate limiting algorithm to query
   * @param identifier - Unique ID for the rate limit subject
   * @param limit - Maximum requests allowed
   * @param windowSeconds - Time window in seconds
   * @param options - Algorithm-specific options
   * @returns Current rate limit state
   */
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

  /**
   * Reset rate limit state for an identifier using a specific algorithm.
   *
   * @param algorithm - Which algorithm's state to reset
   * @param identifier - Unique ID to reset
   */
  async reset(algorithm: Algorithm, identifier: string): Promise<void> {
    const limiter = this.getLimiter(algorithm);
    return limiter.reset(identifier);
  }

  /**
   * Reset rate limit state for an identifier across all algorithms.
   * Useful when you want to completely clear an identifier's history.
   *
   * @param identifier - Unique ID to reset across all algorithms
   */
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
