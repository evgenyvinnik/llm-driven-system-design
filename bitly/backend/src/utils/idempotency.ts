/**
 * Idempotency middleware for URL creation.
 * Prevents duplicate short URLs when clients retry failed requests.
 * Uses Redis to store request fingerprints and their responses.
 */
import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { redis } from './cache.js';
import logger from './logger.js';
import { idempotencyHitsTotal } from './metrics.js';

/**
 * TTL for idempotency keys in Redis (24 hours).
 * After this time, the same request will be treated as new.
 */
const IDEMPOTENCY_TTL = 86400;

/**
 * Prefix for idempotency keys in Redis.
 */
const IDEMPOTENCY_PREFIX = 'idempotency:';

/**
 * Generates a unique fingerprint for a URL creation request.
 * Uses long_url, custom_code, and user_id to identify duplicate requests.
 *
 * @param req - Express request object
 * @returns SHA-256 hash of the request fingerprint
 */
function generateRequestFingerprint(req: Request): string {
  const { long_url, custom_code } = req.body;
  const userId = req.user?.id || 'anonymous';

  // Create a deterministic fingerprint from request data
  const fingerprint = JSON.stringify({
    long_url,
    custom_code: custom_code || null,
    user_id: userId,
  });

  return crypto.createHash('sha256').update(fingerprint).digest('hex');
}

/**
 * Stored idempotency response format.
 */
interface IdempotencyResponse {
  status: number;
  body: unknown;
  created_at: string;
}

/**
 * Middleware to handle idempotent URL creation requests.
 * If the same request was already processed, returns the cached response.
 * Otherwise, allows the request to proceed and caches the response.
 *
 * @param req - Express request object
 * @param res - Express response object
 * @param next - Express next function
 */
export async function idempotencyMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  // Only apply to POST requests for URL creation
  if (req.method !== 'POST') {
    next();
    return;
  }

  // Check for client-provided idempotency key first
  const clientKey = req.headers['idempotency-key'] as string | undefined;

  // Generate fingerprint from request data or use client key
  const idempotencyKey = clientKey || generateRequestFingerprint(req);
  const redisKey = `${IDEMPOTENCY_PREFIX}${idempotencyKey}`;

  try {
    // Check if this request was already processed
    const cached = await redis.get(redisKey);

    if (cached) {
      const response: IdempotencyResponse = JSON.parse(cached);

      logger.info(
        { idempotency_key: idempotencyKey, cached_at: response.created_at },
        'Idempotency cache hit - returning cached response'
      );

      idempotencyHitsTotal.inc();

      // Return cached response
      res.status(response.status).json(response.body);
      return;
    }

    // Store the idempotency key on the request for later use
    (req as Request & { idempotencyKey?: string }).idempotencyKey = idempotencyKey;

    // Intercept the response to cache it
    const originalJson = res.json.bind(res);
    res.json = function (body: unknown) {
      // Only cache successful responses (2xx)
      if (res.statusCode >= 200 && res.statusCode < 300) {
        const response: IdempotencyResponse = {
          status: res.statusCode,
          body,
          created_at: new Date().toISOString(),
        };

        // Store in Redis with TTL (fire and forget)
        redis
          .setex(redisKey, IDEMPOTENCY_TTL, JSON.stringify(response))
          .catch((err) => {
            logger.error({ err, idempotency_key: idempotencyKey }, 'Failed to cache idempotency response');
          });
      }

      return originalJson(body);
    };

    next();
  } catch (error) {
    // If Redis fails, proceed without idempotency (graceful degradation)
    logger.error({ err: error }, 'Idempotency check failed, proceeding without it');
    next();
  }
}

/**
 * Clears an idempotency key from the cache.
 * Useful if you need to allow a retry after an error.
 *
 * @param key - The idempotency key to clear
 */
export async function clearIdempotencyKey(key: string): Promise<void> {
  await redis.del(`${IDEMPOTENCY_PREFIX}${key}`);
}
