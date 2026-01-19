import { v4 as uuidv4 } from 'uuid';
import type { Request, Response, NextFunction } from 'express';
import type Redis from 'ioredis';
import logger from './logger.js';
import { idempotencyHits, idempotencyMisses } from './metrics.js';

/**
 * Idempotency Middleware
 *
 * Prevents duplicate operations when clients retry requests.
 */

interface IdempotencyOptions {
  ttlSeconds: number;
  keyPrefix: string;
  headerName: string;
}

interface CachedResponse {
  statusCode: number;
  body: unknown;
  cachedAt: string;
}

declare module 'express' {
  interface Request {
    idempotencyCacheKey?: string;
    idempotencyTtl?: number;
  }
}

const DEFAULT_OPTIONS: IdempotencyOptions = {
  ttlSeconds: 86400, // 24 hours
  keyPrefix: 'idempotency',
  headerName: 'Idempotency-Key',
};

/**
 * Create idempotency middleware for a specific operation
 */
export function createIdempotencyMiddleware(
  redis: Redis,
  operationType: string,
  options: Partial<IdempotencyOptions> = {}
): (req: Request, res: Response, next: NextFunction) => Promise<void> {
  const config: IdempotencyOptions = { ...DEFAULT_OPTIONS, ...options };

  return async function idempotencyMiddleware(req: Request, res: Response, next: NextFunction): Promise<void> {
    const idempotencyKey = req.headers[config.headerName.toLowerCase()] as string | undefined;

    // If no idempotency key provided, generate one (optional behavior)
    if (!idempotencyKey) {
      req.idempotencyKey = undefined;
      next();
      return;
    }

    // Validate key format (should be UUID or similar)
    if (idempotencyKey.length > 100) {
      res.status(400).json({
        error: 'Idempotency key too long (max 100 characters)',
      });
      return;
    }

    // Build cache key with user context to prevent cross-user conflicts
    const userId = req.session?.userId || 'anonymous';
    const cacheKey = `${config.keyPrefix}:${operationType}:${userId}:${idempotencyKey}`;

    try {
      // Check if we've already processed this request
      const cachedResponse = await redis.get(cacheKey);

      if (cachedResponse) {
        logger.info(
          {
            idempotencyKey,
            operationType,
            userId,
            action: 'cache_hit',
          },
          'Idempotency cache hit - returning cached response',
        );

        idempotencyHits.inc();

        // Return the cached response
        const parsed: CachedResponse = JSON.parse(cachedResponse);
        res.status(parsed.statusCode).json(parsed.body);
        return;
      }

      idempotencyMisses.inc();

      // Store the idempotency key and cache key for later use
      req.idempotencyKey = idempotencyKey;
      req.idempotencyCacheKey = cacheKey;
      req.idempotencyTtl = config.ttlSeconds;

      // Intercept the response to cache it
      const originalJson = res.json.bind(res);
      res.json = function (body: unknown) {
        // Only cache successful responses (2xx)
        if (res.statusCode >= 200 && res.statusCode < 300) {
          const responseToCache: CachedResponse = {
            statusCode: res.statusCode,
            body,
            cachedAt: new Date().toISOString(),
          };

          // Cache the response (fire and forget)
          redis
            .setex(cacheKey, config.ttlSeconds, JSON.stringify(responseToCache))
            .catch((err: Error) => {
              logger.warn(
                {
                  error: err.message,
                  cacheKey,
                },
                'Failed to cache idempotency response',
              );
            });

          logger.debug(
            {
              idempotencyKey,
              operationType,
              userId,
              action: 'cached',
            },
            'Cached idempotency response',
          );
        }

        return originalJson(body);
      };

      next();
    } catch (error) {
      logger.error(
        {
          error: (error as Error).message,
          idempotencyKey,
          operationType,
        },
        'Idempotency middleware error',
      );

      // On Redis error, proceed without idempotency (degraded mode)
      next();
    }
  };
}

/**
 * Pre-configured idempotency middleware factories
 */

/**
 * Idempotency middleware for tweet creation
 */
export function tweetIdempotencyMiddleware(redis: Redis): (req: Request, res: Response, next: NextFunction) => Promise<void> {
  return createIdempotencyMiddleware(redis, 'tweet', {
    ttlSeconds: 86400, // 24 hours
  });
}

/**
 * Idempotency middleware for follow operations
 */
export function followIdempotencyMiddleware(redis: Redis): (req: Request, res: Response, next: NextFunction) => Promise<void> {
  return createIdempotencyMiddleware(redis, 'follow', {
    ttlSeconds: 3600, // 1 hour
  });
}

/**
 * Idempotency middleware for like operations
 */
export function likeIdempotencyMiddleware(redis: Redis): (req: Request, res: Response, next: NextFunction) => Promise<void> {
  return createIdempotencyMiddleware(redis, 'like', {
    ttlSeconds: 3600, // 1 hour
  });
}

/**
 * Idempotency middleware for retweet operations
 */
export function retweetIdempotencyMiddleware(redis: Redis): (req: Request, res: Response, next: NextFunction) => Promise<void> {
  return createIdempotencyMiddleware(redis, 'retweet', {
    ttlSeconds: 3600, // 1 hour
  });
}

/**
 * Generate a new idempotency key
 */
export function generateIdempotencyKey(): string {
  return uuidv4();
}

/**
 * Manually check if an idempotency key exists
 */
export async function checkIdempotencyKey(
  redis: Redis,
  operationType: string,
  userId: string,
  idempotencyKey: string
): Promise<CachedResponse | null> {
  const cacheKey = `${DEFAULT_OPTIONS.keyPrefix}:${operationType}:${userId}:${idempotencyKey}`;
  const cached = await redis.get(cacheKey);
  return cached ? JSON.parse(cached) : null;
}

export default {
  createIdempotencyMiddleware,
  tweetIdempotencyMiddleware,
  followIdempotencyMiddleware,
  likeIdempotencyMiddleware,
  retweetIdempotencyMiddleware,
  generateIdempotencyKey,
  checkIdempotencyKey,
};
