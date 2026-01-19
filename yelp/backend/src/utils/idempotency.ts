import { redis } from './redis.js';
import { logger } from './logger.js';
import { idempotentRequestsTotal } from './metrics.js';
import type { Request, Response, NextFunction } from 'express';

/**
 * Idempotency Module
 *
 * Prevents duplicate operations by tracking unique request keys.
 * Clients send an Idempotency-Key header, and the server:
 * 1. Checks if that key has been used before
 * 2. If yes, returns the cached response
 * 3. If no, processes the request and caches the response
 *
 * This is critical for review submissions where network retries
 * could create duplicate reviews without idempotency protection.
 */

// Extended request interface
interface IdempotentRequest extends Request {
  user?: {
    id: string;
    [key: string]: unknown;
  };
  idempotencyKey?: string;
  idempotencyKeyRaw?: string;
}

// Cached response interface
interface CachedResponse {
  status: number;
  body: unknown;
}

// Middleware options
interface IdempotencyOptions {
  required?: boolean;
  keyHeader?: string;
}

// TTL for idempotency keys (24 hours)
const IDEMPOTENCY_TTL = 86400;

// Redis key prefix
const KEY_PREFIX = 'idempotency:';

/**
 * Check if an idempotency key exists and get its cached response
 */
export async function getIdempotencyResponse(
  key: string
): Promise<CachedResponse | null> {
  try {
    const cached = await redis.get(`${KEY_PREFIX}${key}`);
    if (cached) {
      idempotentRequestsTotal.inc({ action: 'cache_hit' });
      return JSON.parse(cached) as CachedResponse;
    }
    return null;
  } catch (error) {
    logger.warn(
      {
        component: 'idempotency',
        key,
        error: (error as Error).message,
      },
      'Failed to check idempotency key'
    );
    return null;
  }
}

/**
 * Store an idempotency response
 */
export async function setIdempotencyResponse(
  key: string,
  response: CachedResponse,
  ttl: number = IDEMPOTENCY_TTL
): Promise<void> {
  try {
    await redis.setex(`${KEY_PREFIX}${key}`, ttl, JSON.stringify(response));
    idempotentRequestsTotal.inc({ action: 'stored' });
  } catch (error) {
    logger.warn(
      {
        component: 'idempotency',
        key,
        error: (error as Error).message,
      },
      'Failed to store idempotency response'
    );
  }
}

/**
 * Lock an idempotency key to prevent concurrent processing
 * Returns true if lock acquired, false if already locked
 */
export async function lockIdempotencyKey(
  key: string,
  ttl: number = 60
): Promise<boolean> {
  try {
    const lockKey = `${KEY_PREFIX}lock:${key}`;
    const result = await redis.set(lockKey, '1', 'EX', ttl, 'NX');
    return result === 'OK';
  } catch (error) {
    logger.warn(
      {
        component: 'idempotency',
        key,
        error: (error as Error).message,
      },
      'Failed to acquire idempotency lock'
    );
    return false;
  }
}

/**
 * Unlock an idempotency key
 */
export async function unlockIdempotencyKey(key: string): Promise<void> {
  try {
    await redis.del(`${KEY_PREFIX}lock:${key}`);
  } catch (error) {
    logger.warn(
      {
        component: 'idempotency',
        key,
        error: (error as Error).message,
      },
      'Failed to release idempotency lock'
    );
  }
}

/**
 * Idempotency middleware for Express routes
 *
 * Usage:
 *   router.post('/reviews', idempotencyMiddleware, createReview);
 *
 * Clients should send:
 *   Idempotency-Key: <unique-uuid>
 */
export function idempotencyMiddleware(
  options: IdempotencyOptions = {}
): (req: IdempotentRequest, res: Response, next: NextFunction) => Promise<void | Response> {
  const { required = false, keyHeader = 'idempotency-key' } = options;

  return async (
    req: IdempotentRequest,
    res: Response,
    next: NextFunction
  ): Promise<void | Response> => {
    const idempotencyKey = req.headers[keyHeader] as string | undefined;

    // If no key provided
    if (!idempotencyKey) {
      if (required) {
        return res.status(400).json({
          error: {
            message: 'Idempotency-Key header is required for this operation',
          },
        });
      }
      return next();
    }

    // Validate key format (should be a UUID or similar)
    if (idempotencyKey.length < 8 || idempotencyKey.length > 128) {
      return res.status(400).json({
        error: { message: 'Invalid Idempotency-Key format' },
      });
    }

    // Build a composite key including user ID if authenticated
    const userId = req.user?.id || 'anonymous';
    const compositeKey = `${userId}:${req.method}:${req.path}:${idempotencyKey}`;

    // Check for existing response
    const cachedResponse = await getIdempotencyResponse(compositeKey);
    if (cachedResponse) {
      logger.info(
        { component: 'idempotency', key: idempotencyKey, userId },
        'Returning cached idempotent response'
      );
      return res.status(cachedResponse.status).json(cachedResponse.body);
    }

    // Try to acquire lock
    const locked = await lockIdempotencyKey(compositeKey);
    if (!locked) {
      // Another request with same key is being processed
      return res.status(409).json({
        error: {
          message:
            'Request with this Idempotency-Key is already being processed',
        },
      });
    }

    // Store key info for later use in response
    req.idempotencyKey = compositeKey;
    req.idempotencyKeyRaw = idempotencyKey;

    // Override res.json to capture and cache the response
    const originalJson = res.json.bind(res);
    res.json = function (body: unknown): Response {
      const status = res.statusCode;

      // Only cache successful responses (2xx)
      if (status >= 200 && status < 300) {
        setIdempotencyResponse(compositeKey, { status, body });
      }

      // Always unlock
      unlockIdempotencyKey(compositeKey);

      return originalJson(body);
    };

    next();
  };
}

/**
 * Generate an idempotency key for internal use
 */
export function generateIdempotencyKey(): string {
  return `${Date.now()}-${Math.random().toString(36).substring(2, 15)}`;
}

export default {
  getIdempotencyResponse,
  setIdempotencyResponse,
  lockIdempotencyKey,
  unlockIdempotencyKey,
  idempotencyMiddleware,
  generateIdempotencyKey,
};
