import { Request, Response, NextFunction, RequestHandler } from 'express';
import { redis } from '../services/redis.js';
import { idempotencyCache } from './metrics.js';
import { logger } from './logger.js';

/**
 * Idempotency module for safe request replay handling.
 *
 * Purpose:
 * - Prevents duplicate resource creation from retried requests
 * - Ensures consistent responses for identical operations
 * - Handles network failures gracefully (client can retry safely)
 *
 * How it works:
 * 1. Client sends X-Idempotency-Key header with unique request ID
 * 2. Server checks if we've seen this key before
 * 3. If cached: return cached response (no side effects)
 * 4. If new: process request, cache response, return result
 *
 * Trade-offs:
 * - 24-hour TTL balances memory usage vs retry window
 * - Per-user keys prevent cross-user conflicts
 * - Response caching adds ~1ms latency on cache miss
 */

const IDEMPOTENCY_TTL = 24 * 60 * 60; // 24 hours in seconds
const IDEMPOTENCY_PREFIX = 'idempotency';

interface CachedResponse {
  statusCode: number;
  body: unknown;
  cachedAt: string;
}

/**
 * Generates a Redis key for idempotency storage.
 */
function getIdempotencyKey(userId: string, idempotencyKey: string): string {
  return `${IDEMPOTENCY_PREFIX}:${userId}:${idempotencyKey}`;
}

/**
 * Checks if a cached response exists for the idempotency key.
 * Returns the cached response or null if not found.
 */
export async function getIdempotentResponse(userId: string, idempotencyKey: string): Promise<CachedResponse | null> {
  if (!idempotencyKey) return null;

  try {
    const key = getIdempotencyKey(userId, idempotencyKey);
    const cached = await redis.get(key);

    if (cached) {
      idempotencyCache.inc({ result: 'hit' });
      logger.debug({ userId, idempotencyKey }, 'Idempotency cache hit');
      return JSON.parse(cached) as CachedResponse;
    }

    idempotencyCache.inc({ result: 'miss' });
    return null;
  } catch (err) {
    logger.error({ err, userId, idempotencyKey }, 'Idempotency cache get failed');
    return null;
  }
}

/**
 * Stores a response for the idempotency key.
 * TTL ensures cleanup after 24 hours.
 */
export async function setIdempotentResponse(
  userId: string,
  idempotencyKey: string,
  response: CachedResponse
): Promise<void> {
  if (!idempotencyKey) return;

  try {
    const key = getIdempotencyKey(userId, idempotencyKey);
    await redis.setex(key, IDEMPOTENCY_TTL, JSON.stringify(response));
    logger.debug({ userId, idempotencyKey }, 'Idempotency response cached');
  } catch (err) {
    logger.error({ err, userId, idempotencyKey }, 'Idempotency cache set failed');
    // Don't throw - caching failure shouldn't fail the request
  }
}

/**
 * Middleware that handles idempotency for mutating operations.
 *
 * Usage:
 * router.post('/playlists', authenticate, idempotentMiddleware, createPlaylist);
 *
 * Client sends:
 * POST /api/playlists
 * X-Idempotency-Key: 550e8400-e29b-41d4-a716-446655440000
 * Content-Type: application/json
 * { "name": "My Playlist" }
 */
export function idempotentMiddleware(req: Request, res: Response, next: NextFunction): void {
  const idempotencyKey = req.headers['x-idempotency-key'] as string | undefined;

  if (!idempotencyKey) {
    // No idempotency key - proceed normally
    next();
    return;
  }

  if (!req.user?.id) {
    // Require authentication for idempotent operations
    res.status(401).json({ error: 'Authentication required for idempotent operations' });
    return;
  }

  // Store reference to original json method
  const originalJson = res.json.bind(res);

  // Check for cached response
  getIdempotentResponse(req.user.id, idempotencyKey)
    .then(cached => {
      if (cached) {
        // Return cached response
        logger.info({
          userId: req.user!.id,
          idempotencyKey,
          path: req.path
        }, 'Returning idempotent cached response');

        res.set('X-Idempotency-Replayed', 'true');
        res.status(cached.statusCode || 200).json(cached.body);
        return;
      }

      // Override res.json to capture and cache response
      res.json = function(body: unknown) {
        const statusCode = res.statusCode;

        // Only cache successful responses (2xx)
        if (statusCode >= 200 && statusCode < 300) {
          setIdempotentResponse(req.user!.id, idempotencyKey, {
            statusCode,
            body,
            cachedAt: new Date().toISOString()
          });
        }

        return originalJson(body);
      };

      next();
    })
    .catch(err => {
      logger.error({ err }, 'Idempotency middleware error');
      next(); // Continue without idempotency on error
    });
}

type AsyncHandler = (req: Request, res: Response, next: NextFunction) => Promise<unknown>;

/**
 * Helper to wrap route handlers with idempotency support.
 * Provides more control over what gets cached.
 *
 * Usage:
 * router.post('/playlists', authenticate, withIdempotency(async (req, res) => {
 *   // Your handler logic
 *   return { playlist: newPlaylist };
 * }));
 */
export function withIdempotency(handler: AsyncHandler): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const idempotencyKey = req.headers['x-idempotency-key'] as string | undefined;

    if (idempotencyKey && req.user?.id) {
      // Check cache first
      const cached = await getIdempotentResponse(req.user.id, idempotencyKey);
      if (cached) {
        res.set('X-Idempotency-Replayed', 'true');
        res.status(cached.statusCode || 200).json(cached.body);
        return;
      }
    }

    try {
      // Execute handler
      const result = await handler(req, res, next);

      // If handler returned a result (vs sending response directly), cache and send
      if (result !== undefined && !res.headersSent) {
        const statusCode = res.statusCode || 200;

        if (idempotencyKey && req.user?.id && statusCode >= 200 && statusCode < 300) {
          await setIdempotentResponse(req.user.id, idempotencyKey, {
            statusCode,
            body: result,
            cachedAt: new Date().toISOString()
          });
        }

        res.status(statusCode).json(result);
      }
    } catch (err) {
      next(err);
    }
  };
}

/**
 * Validates idempotency key format (should be UUID or similar).
 */
export function validateIdempotencyKey(key: string | undefined): boolean {
  if (!key) return true; // Optional

  // Accept UUID format or any string 8-64 chars
  if (key.length < 8 || key.length > 64) {
    return false;
  }

  // Must be alphanumeric with dashes
  return /^[a-zA-Z0-9-]+$/.test(key);
}

/**
 * Middleware to validate idempotency key format.
 */
export function validateIdempotencyKeyMiddleware(req: Request, res: Response, next: NextFunction): void {
  const key = req.headers['x-idempotency-key'] as string | undefined;

  if (key && !validateIdempotencyKey(key)) {
    res.status(400).json({
      error: 'Invalid X-Idempotency-Key format. Must be 8-64 alphanumeric characters.'
    });
    return;
  }

  next();
}

export default {
  getIdempotentResponse,
  setIdempotentResponse,
  idempotentMiddleware,
  withIdempotency,
  validateIdempotencyKey,
  validateIdempotencyKeyMiddleware
};
