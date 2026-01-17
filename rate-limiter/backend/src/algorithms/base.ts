/**
 * @fileoverview Base interface for all rate limiting algorithms.
 * Defines the contract that all algorithm implementations must follow.
 */

import { RateLimitResult } from '../types/index.js';

/**
 * Options for rate limiting algorithms.
 * Different algorithms use different subsets of these options.
 */
export interface RateLimiterOptions {
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
 * Interface for rate limiter implementations.
 * All rate limiting algorithms (Fixed Window, Sliding Window, Token Bucket, etc.)
 * implement this interface to provide a consistent API.
 */
export interface RateLimiter {
  /**
   * Check if a request should be allowed and consume a token/slot if so.
   * This is the primary method called on each incoming request.
   *
   * @param identifier - Unique ID for the rate limit subject (API key, user ID, IP)
   * @param limit - Maximum requests allowed in the window
   * @param windowSeconds - Duration of the rate limit window
   * @param options - Algorithm-specific options (burstCapacity, refillRate, etc.)
   * @returns Promise resolving to the rate limit result with allowed status and metadata
   */
  check(identifier: string, limit: number, windowSeconds: number, options?: RateLimiterOptions): Promise<RateLimitResult>;

  /**
   * Get current rate limit state for an identifier without consuming a token.
   * Useful for displaying remaining quota to users or admin monitoring.
   *
   * @param identifier - Unique ID for the rate limit subject
   * @param limit - Maximum requests allowed in the window
   * @param windowSeconds - Duration of the rate limit window
   * @param options - Algorithm-specific options (for bucket algorithms)
   * @returns Promise resolving to the current rate limit state
   */
  getState(identifier: string, limit: number, windowSeconds: number, options?: RateLimiterOptions): Promise<RateLimitResult>;

  /**
   * Reset the rate limit state for an identifier.
   * Clears all stored data for the given identifier, allowing immediate access.
   *
   * @param identifier - Unique ID to reset
   * @returns Promise that resolves when the reset is complete
   */
  reset(identifier: string): Promise<void>;
}
