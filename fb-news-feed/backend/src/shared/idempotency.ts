/**
 * @fileoverview Idempotency middleware for preventing duplicate POST requests.
 * Uses Redis to track request idempotency keys and return cached responses
 * for duplicate requests within a configurable time window.
 */

import { Request, Response, NextFunction } from 'express';
import { getIdempotencyResponse, setIdempotencyResponse } from './cache.js';
import { componentLoggers } from './logger.js';

const log = componentLoggers.posts;

/**
 * Header name for idempotency key.
 * Clients should include this header with a unique key (e.g., UUID) for POST requests.
 */
export const IDEMPOTENCY_HEADER = 'X-Idempotency-Key';

/**
 * Response structure stored for idempotent requests.
 */
interface IdempotentResponse {
  statusCode: number;
  body: unknown;
}

/**
 * Middleware to handle idempotent POST requests.
 * If an idempotency key is provided and a response exists for that key,
 * returns the cached response without processing the request again.
 *
 * Usage:
 * - Client includes X-Idempotency-Key header with a unique value
 * - First request is processed normally, response is cached
 * - Subsequent requests with same key return cached response
 * - Key expires after 24 hours
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
  // Only apply to POST requests
  if (req.method !== 'POST') {
    next();
    return;
  }

  const idempotencyKey = req.headers[IDEMPOTENCY_HEADER.toLowerCase()] as string | undefined;

  // If no idempotency key provided, process normally
  if (!idempotencyKey) {
    next();
    return;
  }

  // Validate idempotency key format (should be a reasonable length)
  if (idempotencyKey.length < 8 || idempotencyKey.length > 128) {
    res.status(400).json({
      error: 'Invalid idempotency key',
      message: 'Idempotency key must be between 8 and 128 characters',
    });
    return;
  }

  // Create a composite key including the path to prevent cross-endpoint collisions
  const compositeKey = `${req.user?.id || 'anonymous'}:${req.path}:${idempotencyKey}`;

  try {
    // Check if we have a cached response for this key
    const cached = await getIdempotencyResponse<IdempotentResponse>(compositeKey);

    if (cached.hit && cached.value) {
      log.info({ idempotencyKey, path: req.path }, 'Returning cached idempotent response');

      res.status(cached.value.statusCode).json(cached.value.body);
      return;
    }

    // No cached response, process the request but intercept the response
    const originalJson = res.json.bind(res);

    res.json = function (body: unknown) {
      // Cache the response for future idempotent requests
      const responseToCache: IdempotentResponse = {
        statusCode: res.statusCode,
        body,
      };

      // Only cache successful responses (2xx)
      if (res.statusCode >= 200 && res.statusCode < 300) {
        setIdempotencyResponse(compositeKey, responseToCache).catch((error) => {
          log.error({ error, idempotencyKey }, 'Failed to cache idempotent response');
        });
      }

      return originalJson(body);
    };

    next();
  } catch (error) {
    log.error({ error, idempotencyKey }, 'Idempotency check failed');
    // On error, proceed with the request (fail open)
    next();
  }
}

/**
 * Wrapper function to apply idempotency to specific routes.
 * Returns the idempotency middleware if the route should be idempotent.
 *
 * @returns Express middleware function
 */
export function requireIdempotency() {
  return idempotencyMiddleware;
}
