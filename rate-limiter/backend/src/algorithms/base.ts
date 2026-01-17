// Base rate limiter interface

import { RateLimitResult } from '../types/index.js';

export interface RateLimiter {
  /**
   * Check if a request should be allowed and consume a token if so
   */
  check(identifier: string, limit: number, windowSeconds: number, options?: Record<string, unknown>): Promise<RateLimitResult>;

  /**
   * Get current state for an identifier without consuming
   */
  getState(identifier: string, limit: number, windowSeconds: number): Promise<RateLimitResult>;

  /**
   * Reset the rate limit state for an identifier
   */
  reset(identifier: string): Promise<void>;
}
