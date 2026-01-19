/**
 * Idempotency middleware for safe request retries
 *
 * Provides idempotency for mutating operations to handle:
 * - Network failures causing client retries
 * - Duplicate form submissions
 * - Mobile app background retry behavior
 *
 * Uses Redis to store request results with TTL.
 * Clients send an Idempotency-Key header to enable this behavior.
 */
import { v4 as uuid } from 'uuid';
import { Request, Response, NextFunction } from 'express';
import { RedisClientType } from 'redis';
import { logger } from './logger.js';
import { idempotentRequestsTotal } from './metrics.js';

// TTL for idempotency records (24 hours)
export const IDEMPOTENCY_TTL = 86400;
// Lock TTL to prevent concurrent processing (30 seconds)
export const LOCK_TTL = 30;

export interface WatchProgressMeta {
  idempotencyKey: string;
  clientTimestamp: number;
}

export interface CachedResponse {
  status: number;
  body: unknown;
}

// Extend Express Request type
declare global {
  namespace Express {
    interface Request {
      watchProgressMeta?: WatchProgressMeta;
    }
  }
}

/**
 * Express middleware for idempotent request handling
 *
 * @param redis - Redis client
 * @returns Express middleware
 */
export function idempotencyMiddleware(redis: RedisClientType) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    // Only apply to mutating methods
    if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
      next();
      return;
    }

    const idempotencyKey = req.headers['idempotency-key'] as string | undefined;

    // If no idempotency key, proceed normally
    if (!idempotencyKey) {
      next();
      return;
    }

    const userId = req.session?.userId || 'anonymous';
    const cacheKey = `idempotency:${userId}:${idempotencyKey}`;
    const lockKey = `${cacheKey}:lock`;

    try {
      // Check if we already have a cached response
      const cached = await redis.get(cacheKey);
      if (cached) {
        const response = JSON.parse(cached) as CachedResponse;
        idempotentRequestsTotal.inc({ result: 'cached' });

        if (req.log) {
          req.log.info({
            idempotencyKey,
            cachedStatus: response.status
          }, 'Returning cached idempotent response');
        }

        res.status(response.status).json(response.body);
        return;
      }

      // Try to acquire lock for processing
      const lockAcquired = await redis.set(lockKey, '1', {
        NX: true,
        EX: LOCK_TTL
      });

      if (!lockAcquired) {
        // Another request is processing this idempotency key
        idempotentRequestsTotal.inc({ result: 'in_progress' });
        res.status(409).json({
          error: 'Request already in progress',
          idempotencyKey
        });
        return;
      }

      // Store original response methods
      const originalJson = res.json.bind(res);
      const originalSend = res.send.bind(res);

      // Override json method to cache the response
      res.json = function(body: unknown): Response {
        (async () => {
          try {
            // Cache the response
            await redis.setEx(cacheKey, IDEMPOTENCY_TTL, JSON.stringify({
              status: res.statusCode,
              body
            }));
            // Release lock
            await redis.del(lockKey);
            idempotentRequestsTotal.inc({ result: 'new' });
          } catch (cacheError) {
            logger.error({
              error: (cacheError as Error).message,
              idempotencyKey
            }, 'Failed to cache idempotent response');
          }
        })();

        return originalJson(body);
      };

      // Override send method similarly
      res.send = function(body: unknown): Response {
        (async () => {
          try {
            // Only cache JSON responses
            if (res.get('Content-Type')?.includes('application/json')) {
              await redis.setEx(cacheKey, IDEMPOTENCY_TTL, JSON.stringify({
                status: res.statusCode,
                body: typeof body === 'string' ? JSON.parse(body) : body
              }));
            }
            await redis.del(lockKey);
          } catch (cacheError) {
            logger.error({
              error: (cacheError as Error).message,
              idempotencyKey
            }, 'Failed to cache idempotent response');
          }
        })();

        return originalSend(body);
      };

      next();
    } catch (error) {
      logger.error({
        error: (error as Error).message,
        idempotencyKey
      }, 'Idempotency middleware error');

      // On error, proceed without idempotency protection
      next();
    }
  };
}

/**
 * Create an idempotency key for a specific operation
 * Useful for server-side idempotency (e.g., background jobs)
 *
 * @param operation - Operation name
 * @param parts - Additional key parts
 * @returns Idempotency key
 */
export function createIdempotencyKey(operation: string, ...parts: string[]): string {
  return `${operation}:${parts.join(':')}:${uuid()}`;
}

/**
 * Check if an operation has already been performed (idempotent check)
 *
 * @param redis - Redis client
 * @param key - Idempotency key
 * @returns Cached result or null
 */
export async function checkIdempotency(
  redis: RedisClientType,
  key: string
): Promise<unknown | null> {
  const cached = await redis.get(`idempotency:${key}`);
  return cached ? JSON.parse(cached) : null;
}

/**
 * Mark an operation as completed (idempotent store)
 *
 * @param redis - Redis client
 * @param key - Idempotency key
 * @param result - Operation result to cache
 * @param ttl - TTL in seconds (default 24 hours)
 */
export async function markIdempotent(
  redis: RedisClientType,
  key: string,
  result: unknown,
  ttl: number = IDEMPOTENCY_TTL
): Promise<void> {
  await redis.setEx(`idempotency:${key}`, ttl, JSON.stringify(result));
}

/**
 * Middleware specifically for watch progress updates
 * Uses content-based idempotency with timestamp comparison
 *
 * @param redis - Redis client
 * @returns Express middleware
 */
export function watchProgressIdempotency(redis: RedisClientType) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    if (req.method !== 'POST') {
      next();
      return;
    }

    const { contentId } = req.params;
    const profileId = req.session?.profileId;
    const { clientTimestamp } = req.body as { position?: number; clientTimestamp?: number };

    if (!profileId || !contentId) {
      next();
      return;
    }

    // Create a deterministic key based on the update parameters
    const idempotencyKey = `progress:${profileId}:${contentId}`;

    try {
      // Get last update info
      const lastUpdate = await redis.get(idempotencyKey);

      if (lastUpdate) {
        const parsed = JSON.parse(lastUpdate) as { clientTimestamp: number };

        // If client timestamp is older or equal, skip update
        if (clientTimestamp && parsed.clientTimestamp >= clientTimestamp) {
          if (req.log) {
            req.log.info({
              contentId,
              profileId,
              clientTimestamp,
              lastTimestamp: parsed.clientTimestamp
            }, 'Skipping stale progress update');
          }

          res.json({
            success: true,
            skipped: true,
            reason: 'stale_update'
          });
          return;
        }
      }

      // Store the update info for future comparisons (short TTL)
      // Actual persistence happens in the route handler
      req.watchProgressMeta = {
        idempotencyKey,
        clientTimestamp: clientTimestamp || Date.now()
      };

      next();
    } catch (error) {
      logger.error({
        error: (error as Error).message,
        contentId,
        profileId
      }, 'Watch progress idempotency check failed');
      next();
    }
  };
}

/**
 * Helper to complete watch progress idempotency after successful update
 *
 * @param redis - Redis client
 * @param meta - Idempotency metadata from request
 */
export async function completeWatchProgressIdempotency(
  redis: RedisClientType,
  meta?: WatchProgressMeta
): Promise<void> {
  if (!meta?.idempotencyKey) return;

  await redis.setEx(meta.idempotencyKey, 60, JSON.stringify({
    clientTimestamp: meta.clientTimestamp,
    updatedAt: Date.now()
  }));
}
