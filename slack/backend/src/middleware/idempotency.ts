/**
 * @fileoverview Idempotency middleware for preventing duplicate message sends.
 * Uses Redis to cache request outcomes by client-provided idempotency keys.
 * This ensures network retries don't create duplicate messages in the system.
 */

import { Request, Response, NextFunction } from 'express';
import { redis } from '../services/redis.js';
import { logger } from '../services/logger.js';
import { idempotencyHitsCounter } from '../services/metrics.js';

/** TTL for idempotency keys in seconds (24 hours) */
const IDEMPOTENCY_TTL = 86400;

/** Prefix for idempotency cache keys */
const IDEMPOTENCY_PREFIX = 'idem:';

/**
 * Extended Express Response interface to capture the response body.
 */
interface IdempotentResponse extends Response {
  _idempotencyKey?: string;
  _idempotencyBody?: unknown;
}

/**
 * Creates middleware that enforces idempotency for write operations.
 * The client must provide an `X-Idempotency-Key` header with a unique identifier.
 * If the same key is seen again within the TTL, the cached response is returned.
 *
 * WHY: Network failures can cause clients to retry requests. Without idempotency,
 * this would create duplicate messages. By caching the response by idempotency key,
 * retries receive the same response without creating duplicate database records.
 *
 * @returns Express middleware function
 */
export function idempotencyMiddleware() {
  return async (req: Request, res: IdempotentResponse, next: NextFunction): Promise<void> => {
    const idempotencyKey = req.headers['x-idempotency-key'] as string | undefined;

    // If no idempotency key provided, proceed without protection
    if (!idempotencyKey) {
      next();
      return;
    }

    const userId = req.session.userId;
    if (!userId) {
      next();
      return;
    }

    // Include user ID in the cache key to prevent cross-user conflicts
    const cacheKey = `${IDEMPOTENCY_PREFIX}${userId}:${idempotencyKey}`;

    try {
      // Check if we've already processed this request
      const cached = await redis.get(cacheKey);

      if (cached) {
        // Return the cached response
        const cachedResponse = JSON.parse(cached);
        idempotencyHitsCounter.inc();

        logger.info({
          msg: 'Idempotency cache hit - returning cached response',
          idempotencyKey,
          userId,
        });

        res.status(cachedResponse.statusCode).json(cachedResponse.body);
        return;
      }

      // Store the key temporarily to mark request as in-progress (prevents race conditions)
      const lockKey = `${cacheKey}:lock`;
      const lockAcquired = await redis.set(lockKey, '1', 'EX', 30, 'NX');

      if (!lockAcquired) {
        // Another request with the same key is in progress
        res.status(409).json({ error: 'Request with this idempotency key is already in progress' });
        return;
      }

      // Store reference for response capture
      res._idempotencyKey = cacheKey;

      // Override json method to capture and cache the response
      const originalJson = res.json.bind(res);
      res.json = function (body: unknown) {
        // Cache the response for future retries
        if (res._idempotencyKey && res.statusCode >= 200 && res.statusCode < 300) {
          const responseToCache = {
            statusCode: res.statusCode,
            body,
          };

          redis.setex(res._idempotencyKey, IDEMPOTENCY_TTL, JSON.stringify(responseToCache))
            .catch((err) => logger.error({ err, msg: 'Failed to cache idempotency response' }));
        }

        // Clean up the lock
        redis.del(lockKey).catch(() => {});

        return originalJson(body);
      };

      next();
    } catch (error) {
      logger.error({ err: error, msg: 'Idempotency middleware error' });
      next();
    }
  };
}

/**
 * Generates an idempotency key for a message send operation.
 * Clients should use this pattern to create their idempotency keys.
 * @param channelId - The channel the message is being sent to
 * @param content - The message content
 * @param timestamp - Client timestamp of the request
 * @returns Idempotency key string
 */
export function generateMessageIdempotencyKey(
  channelId: string,
  content: string,
  timestamp: number
): string {
  // Create a deterministic key from channel, content hash, and timestamp
  const contentHash = Buffer.from(content).toString('base64').substring(0, 16);
  return `msg:${channelId}:${contentHash}:${timestamp}`;
}
