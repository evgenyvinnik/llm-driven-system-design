/**
 * @fileoverview Rate limiting middleware using Redis sliding window algorithm.
 * Prevents abuse by limiting requests per user and per workspace.
 *
 * WHY rate limiting:
 * - Prevents abuse - stops malicious users from spamming messages or exhausting resources
 * - Ensures fair usage - no single user can monopolize server capacity
 * - Protects downstream services - prevents cascading failures from request floods
 * - Enables capacity planning - predictable load based on rate limit configurations
 */

import { Request, Response, NextFunction } from 'express';
import { redis } from '../services/redis.js';
import { logger } from '../services/logger.js';
import { rateLimitCounter } from '../services/metrics.js';

/**
 * Rate limit configuration for different operations.
 * Higher limits for admins, lower for write operations.
 */
export const RATE_LIMITS = {
  // Message operations
  SEND_MESSAGE: { limit: 60, windowSec: 60 },         // 60 per minute
  EDIT_MESSAGE: { limit: 30, windowSec: 60 },         // 30 per minute
  DELETE_MESSAGE: { limit: 30, windowSec: 60 },       // 30 per minute

  // Reaction operations
  ADD_REACTION: { limit: 30, windowSec: 60 },         // 30 per minute

  // Channel operations
  CREATE_CHANNEL: { limit: 10, windowSec: 60 },       // 10 per minute
  JOIN_CHANNEL: { limit: 20, windowSec: 60 },         // 20 per minute

  // Search operations
  SEARCH: { limit: 20, windowSec: 60 },               // 20 per minute

  // File operations
  UPLOAD_FILE: { limit: 20, windowSec: 60 },          // 20 per minute

  // Webhook operations
  SEND_WEBHOOK: { limit: 5, windowSec: 60 },          // 5 per minute

  // Default for unspecified operations
  DEFAULT: { limit: 100, windowSec: 60 },             // 100 per minute
} as const;

export type RateLimitType = keyof typeof RATE_LIMITS;

/**
 * Admin role multiplier - admins get higher limits.
 */
const ADMIN_MULTIPLIER = 2;

/**
 * Result of a rate limit check.
 */
interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  limit: number;
  resetAt: number;
}

/**
 * Sliding window rate limiter using Redis sorted sets.
 * More accurate than fixed window, prevents burst traffic at window boundaries.
 *
 * @param key - Unique identifier for the rate limit bucket
 * @param limit - Maximum number of requests allowed
 * @param windowSec - Time window in seconds
 * @returns Rate limit check result
 */
async function checkRateLimit(key: string, limit: number, windowSec: number): Promise<RateLimitResult> {
  const now = Date.now();
  const windowStart = now - windowSec * 1000;

  try {
    // Execute as a pipeline for atomicity
    const pipeline = redis.pipeline();

    // Remove old entries outside the window
    pipeline.zremrangebyscore(key, 0, windowStart);

    // Add current request with timestamp as score
    pipeline.zadd(key, now, `${now}:${Math.random()}`);

    // Count requests in current window
    pipeline.zcard(key);

    // Set TTL on the key
    pipeline.expire(key, windowSec);

    const results = await pipeline.exec();

    // zcard result is at index 2
    const count = (results?.[2]?.[1] as number) || 0;
    const remaining = Math.max(0, limit - count);
    const resetAt = now + windowSec * 1000;

    return {
      allowed: count <= limit,
      remaining,
      limit,
      resetAt,
    };
  } catch (error) {
    logger.error({ err: error, key, msg: 'Rate limit check error' });
    // On error, allow the request (fail open for better UX)
    return { allowed: true, remaining: limit, limit, resetAt: now + windowSec * 1000 };
  }
}

/**
 * Creates rate limiting middleware for a specific operation type.
 * Applies per-user rate limits with admin privilege escalation.
 *
 * @param operation - The type of operation being rate limited
 * @returns Express middleware function
 *
 * @example
 * // Apply rate limiting to message sending
 * router.post('/messages', rateLimit('SEND_MESSAGE'), sendMessage);
 */
export function rateLimit(operation: RateLimitType = 'DEFAULT') {
  const config = RATE_LIMITS[operation] || RATE_LIMITS.DEFAULT;

  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const userId = req.session.userId;

    if (!userId) {
      // No rate limiting for unauthenticated requests (should be blocked by auth middleware)
      next();
      return;
    }

    // Determine effective limit based on user role
    const isAdmin = req.membership?.role === 'admin' || req.membership?.role === 'owner';
    const effectiveLimit = isAdmin ? config.limit * ADMIN_MULTIPLIER : config.limit;

    // Create rate limit key: user + operation
    const key = `ratelimit:${userId}:${operation}`;

    const result = await checkRateLimit(key, effectiveLimit, config.windowSec);

    // Set rate limit headers
    res.set('X-RateLimit-Limit', String(result.limit));
    res.set('X-RateLimit-Remaining', String(result.remaining));
    res.set('X-RateLimit-Reset', String(Math.floor(result.resetAt / 1000)));

    if (!result.allowed) {
      rateLimitCounter.inc({ endpoint: operation });

      logger.warn({
        msg: 'Rate limit exceeded',
        userId,
        operation,
        limit: result.limit,
      });

      res.status(429).json({
        error: 'Rate limit exceeded',
        limit: result.limit,
        remaining: 0,
        retryAfter: Math.ceil((result.resetAt - Date.now()) / 1000),
      });
      return;
    }

    next();
  };
}

/**
 * Creates rate limiting middleware for workspace-scoped operations.
 * Applies per-workspace limits in addition to per-user limits.
 *
 * @param operation - The type of operation being rate limited
 * @returns Express middleware function
 */
export function rateLimitWorkspace(operation: RateLimitType = 'DEFAULT') {
  const config = RATE_LIMITS[operation] || RATE_LIMITS.DEFAULT;
  // Workspace limits are higher than user limits
  const workspaceLimit = config.limit * 10;

  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const userId = req.session.userId;
    const workspaceId = req.session.workspaceId || req.params.workspaceId;

    if (!userId) {
      next();
      return;
    }

    // Check per-user limit first
    const userKey = `ratelimit:${userId}:${operation}`;
    const userResult = await checkRateLimit(userKey, config.limit, config.windowSec);

    if (!userResult.allowed) {
      rateLimitCounter.inc({ endpoint: `${operation}:user` });
      res.status(429).json({
        error: 'User rate limit exceeded',
        retryAfter: Math.ceil((userResult.resetAt - Date.now()) / 1000),
      });
      return;
    }

    // Check per-workspace limit if workspace context exists
    if (workspaceId) {
      const workspaceKey = `ratelimit:workspace:${workspaceId}:${operation}`;
      const workspaceResult = await checkRateLimit(workspaceKey, workspaceLimit, config.windowSec);

      if (!workspaceResult.allowed) {
        rateLimitCounter.inc({ endpoint: `${operation}:workspace` });
        res.status(429).json({
          error: 'Workspace rate limit exceeded',
          retryAfter: Math.ceil((workspaceResult.resetAt - Date.now()) / 1000),
        });
        return;
      }

      // Add workspace rate limit headers
      res.set('X-Workspace-RateLimit-Limit', String(workspaceResult.limit));
      res.set('X-Workspace-RateLimit-Remaining', String(workspaceResult.remaining));
    }

    // Set user rate limit headers
    res.set('X-RateLimit-Limit', String(userResult.limit));
    res.set('X-RateLimit-Remaining', String(userResult.remaining));
    res.set('X-RateLimit-Reset', String(Math.floor(userResult.resetAt / 1000)));

    next();
  };
}

/**
 * Simple fixed-window rate limiter for less critical operations.
 * Uses a simple counter with expiration - less accurate but more efficient.
 *
 * @param limit - Maximum requests per window
 * @param windowSec - Window duration in seconds
 * @returns Express middleware function
 */
export function simpleRateLimit(limit: number, windowSec: number) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const userId = req.session.userId;
    if (!userId) {
      next();
      return;
    }

    const key = `ratelimit:simple:${userId}:${req.path}`;

    try {
      const count = await redis.incr(key);

      if (count === 1) {
        // First request in window - set expiration
        await redis.expire(key, windowSec);
      }

      if (count > limit) {
        const ttl = await redis.ttl(key);
        res.status(429).json({
          error: 'Rate limit exceeded',
          retryAfter: ttl,
        });
        return;
      }

      res.set('X-RateLimit-Limit', String(limit));
      res.set('X-RateLimit-Remaining', String(Math.max(0, limit - count)));

      next();
    } catch (error) {
      logger.error({ err: error, msg: 'Simple rate limit error' });
      next(); // Fail open
    }
  };
}
