import type { Response, NextFunction } from 'express';
import redis from '../utils/redis.js';
import { createLogger } from '../utils/logger.js';
import { metrics } from '../utils/metrics.js';
import type { AuthenticatedRequest, IdempotentResponse } from '../types/index.js';

const logger = createLogger('idempotency');

const IDEMPOTENCY_PREFIX = 'idempotency:';
const PENDING_MARKER = 'pending';
const DEFAULT_TTL = 86400; // 24 hours
const PENDING_TTL = 60; // 60 seconds for in-flight requests

// Idempotency middleware options
interface IdempotencyOptions {
  operation?: string;
  ttl?: number;
}

/**
 * Idempotency middleware factory
 * Prevents duplicate requests by caching responses for a given idempotency key
 *
 * @param options - Middleware options
 * @returns Express middleware
 */
export function idempotencyMiddleware(options: IdempotencyOptions = {}) {
  const { operation = 'unknown', ttl = DEFAULT_TTL } = options;

  return async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
    // Get idempotency key from header
    const idempotencyKey = req.headers['x-idempotency-key'] as string | undefined;

    // If no idempotency key, proceed normally
    if (!idempotencyKey) {
      next();
      return;
    }

    // Validate idempotency key format (should be UUID-like)
    if (!/^[a-zA-Z0-9-]{8,64}$/.test(idempotencyKey)) {
      res.status(400).json({
        error: 'Invalid idempotency key format. Must be 8-64 alphanumeric characters.',
      });
      return;
    }

    // Create cache key with user context to prevent cross-user collisions
    const userId = req.user?.id || 'anonymous';
    const cacheKey = `${IDEMPOTENCY_PREFIX}${operation}:${userId}:${idempotencyKey}`;

    try {
      // Check if request was already processed
      const cached = await redis.get(cacheKey);

      if (cached) {
        if (cached === PENDING_MARKER) {
          // Request is currently being processed
          logger.warn(
            { operation, idempotencyKey, userId },
            'Duplicate request while original is still processing'
          );
          metrics.idempotencyHits.inc({ operation });
          res.status(409).json({
            error: 'Request with this idempotency key is currently being processed',
            retryAfter: 5,
          });
          return;
        }

        // Return cached response
        try {
          const { statusCode, body } = JSON.parse(cached) as IdempotentResponse;
          logger.info(
            { operation, idempotencyKey, userId, statusCode },
            'Returning cached idempotent response'
          );
          metrics.idempotencyHits.inc({ operation });
          res.status(statusCode).json(body);
          return;
        } catch (parseError) {
          // If we can't parse the cached response, delete it and proceed
          const err = parseError as Error;
          logger.error(
            { operation, idempotencyKey, error: err.message },
            'Failed to parse cached response, clearing'
          );
          await redis.del(cacheKey);
        }
      }

      metrics.idempotencyMisses.inc({ operation });

      // Set pending marker to prevent concurrent duplicate requests
      const acquired = await redis.set(cacheKey, PENDING_MARKER, 'NX', 'EX', PENDING_TTL);

      if (!acquired) {
        // Another request with the same key started just now
        logger.warn(
          { operation, idempotencyKey, userId },
          'Race condition: concurrent request with same idempotency key'
        );
        res.status(409).json({
          error: 'Request with this idempotency key is currently being processed',
          retryAfter: 5,
        });
        return;
      }

      // Store original response methods
      const originalJson = res.json.bind(res);
      const originalSend = res.send.bind(res);

      // Override response methods to capture and cache the response
      const cacheResponse = async (body: unknown): Promise<void> => {
        try {
          const responseData: IdempotentResponse = {
            statusCode: res.statusCode,
            body: typeof body === 'string' ? JSON.parse(body) : body,
            cachedAt: Date.now(),
          };

          // Cache the response
          await redis.set(cacheKey, JSON.stringify(responseData), 'EX', ttl);

          logger.debug(
            { operation, idempotencyKey, userId, statusCode: res.statusCode },
            'Cached idempotent response'
          );
        } catch (cacheError) {
          // Log but don't fail the request if caching fails
          const err = cacheError as Error;
          logger.error(
            { operation, idempotencyKey, error: err.message },
            'Failed to cache idempotent response'
          );
        }
      };

      res.json = function (body: unknown): Response {
        cacheResponse(body);
        return originalJson(body);
      };

      res.send = function (body: unknown): Response {
        if (typeof body === 'object') {
          cacheResponse(body);
        }
        return originalSend(body);
      };

      // Clean up pending marker on error
      res.on('close', async () => {
        if (!res.writableEnded) {
          // Request was aborted, clean up pending marker
          await redis.del(cacheKey);
        }
      });

      next();
    } catch (error) {
      const err = error as Error;
      logger.error(
        { operation, idempotencyKey, error: err.message },
        'Idempotency middleware error'
      );

      // If Redis fails, proceed without idempotency (fail open)
      next();
    }
  };
}

/**
 * Check if a request with given idempotency key has already been processed
 * @param operation - Operation name
 * @param userId - User ID
 * @param idempotencyKey - Idempotency key
 * @returns Cached response or null
 */
export async function getIdempotentResponse(
  operation: string,
  userId: string,
  idempotencyKey: string
): Promise<IdempotentResponse | null> {
  const cacheKey = `${IDEMPOTENCY_PREFIX}${operation}:${userId}:${idempotencyKey}`;

  try {
    const cached = await redis.get(cacheKey);

    if (cached && cached !== PENDING_MARKER) {
      return JSON.parse(cached) as IdempotentResponse;
    }

    return null;
  } catch (error) {
    const err = error as Error;
    logger.error({ operation, idempotencyKey, error: err.message }, 'Failed to get idempotent response');
    return null;
  }
}

// Response to set
interface ResponseToSet {
  statusCode?: number;
  body: unknown;
}

/**
 * Manually set an idempotent response
 * Useful for background operations that need idempotency
 * @param operation - Operation name
 * @param userId - User ID
 * @param idempotencyKey - Idempotency key
 * @param response - Response to cache
 * @param ttl - TTL in seconds
 */
export async function setIdempotentResponse(
  operation: string,
  userId: string,
  idempotencyKey: string,
  response: ResponseToSet,
  customTtl: number = DEFAULT_TTL
): Promise<void> {
  const cacheKey = `${IDEMPOTENCY_PREFIX}${operation}:${userId}:${idempotencyKey}`;

  try {
    const responseData: IdempotentResponse = {
      statusCode: response.statusCode || 200,
      body: response.body,
      cachedAt: Date.now(),
    };

    await redis.set(cacheKey, JSON.stringify(responseData), 'EX', customTtl);

    logger.debug({ operation, idempotencyKey, userId }, 'Set idempotent response');
  } catch (error) {
    const err = error as Error;
    logger.error({ operation, idempotencyKey, error: err.message }, 'Failed to set idempotent response');
  }
}

/**
 * Clear an idempotent response
 * @param operation - Operation name
 * @param userId - User ID
 * @param idempotencyKey - Idempotency key
 */
export async function clearIdempotentResponse(
  operation: string,
  userId: string,
  idempotencyKey: string
): Promise<void> {
  const cacheKey = `${IDEMPOTENCY_PREFIX}${operation}:${userId}:${idempotencyKey}`;

  try {
    await redis.del(cacheKey);
    logger.debug({ operation, idempotencyKey, userId }, 'Cleared idempotent response');
  } catch (error) {
    const err = error as Error;
    logger.error({ operation, idempotencyKey, error: err.message }, 'Failed to clear idempotent response');
  }
}

export default {
  idempotencyMiddleware,
  getIdempotentResponse,
  setIdempotentResponse,
  clearIdempotentResponse,
};
