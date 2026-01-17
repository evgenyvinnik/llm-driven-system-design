/**
 * Idempotency Middleware for Payment Operations
 *
 * CRITICAL: Prevents duplicate payment processing when network retries occur.
 * Uses Redis to store request fingerprints and results.
 *
 * WHY Idempotency is Critical for Payments:
 * 1. Network failures may cause clients to retry requests
 * 2. Without idempotency, retries can charge customers twice
 * 3. Payment networks expect unique transactions (duplicate detection)
 * 4. Audit/compliance requires clear transaction lineage
 *
 * Implementation Details:
 * - Uses client-provided Idempotency-Key header
 * - Stores request hash + result in Redis for 24 hours
 * - Returns cached response for duplicate requests
 * - Prevents concurrent execution of same request
 *
 * Flow:
 * 1. Client sends request with Idempotency-Key header
 * 2. Middleware checks Redis for existing result
 * 3a. If found: Return cached response (202 or original status)
 * 3b. If not found: Execute request, cache result, return response
 *
 * @see architecture.md "Consistency and Idempotency Semantics" section
 */
import { Request, Response, NextFunction } from 'express';
import redis from '../db/redis.js';
import { logger } from './logger.js';
import { idempotencyCacheOps } from './metrics.js';

/**
 * Configuration for idempotency behavior.
 */
interface IdempotencyConfig {
  /** TTL for cached results in seconds (default: 24 hours) */
  ttlSeconds: number;
  /** Lock timeout for in-progress requests in seconds (default: 60) */
  lockTimeoutSeconds: number;
  /** Header name for idempotency key (default: Idempotency-Key) */
  headerName: string;
  /** Whether to require idempotency key (default: true for payments) */
  required: boolean;
}

const defaultConfig: IdempotencyConfig = {
  ttlSeconds: 86400, // 24 hours
  lockTimeoutSeconds: 60,
  headerName: 'Idempotency-Key',
  required: true,
};

/**
 * Cached response structure stored in Redis.
 */
interface CachedResponse {
  status: 'in_progress' | 'completed';
  statusCode?: number;
  body?: unknown;
  headers?: Record<string, string>;
  completedAt?: number;
  requestHash?: string;
}

/**
 * Creates request fingerprint from body.
 * Used to detect different payloads with same idempotency key.
 */
function createRequestHash(body: unknown): string {
  const str = JSON.stringify(body || {});
  // Simple hash for demo - in production use crypto.createHash
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash; // Convert to 32-bit integer
  }
  return hash.toString(16);
}

/**
 * Idempotency middleware factory.
 * Apply to mutation endpoints (POST, PUT, DELETE) that should not be duplicated.
 *
 * @param config - Optional configuration overrides
 * @returns Express middleware function
 *
 * @example
 * // Apply to payment endpoint
 * router.post('/pay', authMiddleware, idempotencyMiddleware(), async (req, res) => {
 *   // This will only execute once per idempotency key
 * });
 *
 * @example
 * // Apply with custom config
 * router.post('/refund', idempotencyMiddleware({ ttlSeconds: 3600 }), async (req, res) => {
 *   // Refund results cached for 1 hour
 * });
 */
export function idempotencyMiddleware(config: Partial<IdempotencyConfig> = {}) {
  const cfg = { ...defaultConfig, ...config };

  return async function (req: Request, res: Response, next: NextFunction) {
    const idempotencyKey = req.headers[cfg.headerName.toLowerCase()] as string | undefined;

    // If no idempotency key and not required, skip middleware
    if (!idempotencyKey) {
      if (cfg.required) {
        logger.warn({ path: req.path, method: req.method }, 'Missing idempotency key for payment operation');
        return res.status(400).json({
          error: 'Idempotency-Key header is required for this operation',
          code: 'IDEMPOTENCY_KEY_REQUIRED',
        });
      }
      return next();
    }

    // Validate idempotency key format (UUID or similar)
    if (idempotencyKey.length < 16 || idempotencyKey.length > 128) {
      return res.status(400).json({
        error: 'Invalid Idempotency-Key format',
        code: 'INVALID_IDEMPOTENCY_KEY',
      });
    }

    const cacheKey = `idempotency:${req.path}:${idempotencyKey}`;
    const requestHash = createRequestHash(req.body);

    try {
      // Check for existing cached response
      const cached = await redis.get(cacheKey);

      if (cached) {
        const cachedResponse: CachedResponse = JSON.parse(cached);

        // If request is still in progress, return 409 Conflict
        if (cachedResponse.status === 'in_progress') {
          idempotencyCacheOps.inc({ operation: 'check', result: 'in_progress' });
          logger.info({ idempotencyKey }, 'Request already in progress');
          return res.status(409).json({
            error: 'Request with this idempotency key is already being processed',
            code: 'REQUEST_IN_PROGRESS',
          });
        }

        // If completed, verify request hash matches
        if (cachedResponse.requestHash && cachedResponse.requestHash !== requestHash) {
          idempotencyCacheOps.inc({ operation: 'check', result: 'hash_mismatch' });
          logger.warn(
            { idempotencyKey, originalHash: cachedResponse.requestHash, newHash: requestHash },
            'Idempotency key reused with different payload'
          );
          return res.status(422).json({
            error: 'Idempotency key was already used with different request parameters',
            code: 'IDEMPOTENCY_KEY_REUSED',
          });
        }

        // Return cached response
        idempotencyCacheOps.inc({ operation: 'check', result: 'hit' });
        logger.info(
          { idempotencyKey, completedAt: cachedResponse.completedAt },
          'Returning cached response for idempotent request'
        );

        // Set header to indicate this is a cached response
        res.setHeader('X-Idempotency-Replayed', 'true');

        // Restore any cached headers
        if (cachedResponse.headers) {
          Object.entries(cachedResponse.headers).forEach(([key, value]) => {
            res.setHeader(key, value);
          });
        }

        return res.status(cachedResponse.statusCode || 200).json(cachedResponse.body);
      }

      // No cached response - acquire lock and proceed
      const lockAcquired = await redis.set(
        cacheKey,
        JSON.stringify({
          status: 'in_progress',
          requestHash,
          startedAt: Date.now(),
        } as CachedResponse),
        'EX',
        cfg.lockTimeoutSeconds,
        'NX'
      );

      if (!lockAcquired) {
        // Another request acquired the lock between our check and set
        idempotencyCacheOps.inc({ operation: 'lock', result: 'contention' });
        return res.status(409).json({
          error: 'Request with this idempotency key is already being processed',
          code: 'REQUEST_IN_PROGRESS',
        });
      }

      idempotencyCacheOps.inc({ operation: 'lock', result: 'acquired' });

      // Store original res.json to intercept response
      const originalJson = res.json.bind(res);

      res.json = function (body: unknown) {
        // Cache the successful response
        const responseToCache: CachedResponse = {
          status: 'completed',
          statusCode: res.statusCode,
          body,
          requestHash,
          completedAt: Date.now(),
          headers: {
            'X-Transaction-Id': res.getHeader('X-Transaction-Id') as string,
          },
        };

        // Don't await - cache asynchronously
        redis
          .set(cacheKey, JSON.stringify(responseToCache), 'EX', cfg.ttlSeconds)
          .then(() => {
            idempotencyCacheOps.inc({ operation: 'store', result: 'success' });
          })
          .catch((err) => {
            // Log but don't fail the request
            logger.error({ error: err, idempotencyKey }, 'Failed to cache idempotent response');
            idempotencyCacheOps.inc({ operation: 'store', result: 'error' });
          });

        return originalJson(body);
      };

      // Handle errors - clear the lock
      const cleanup = async () => {
        try {
          await redis.del(cacheKey);
          idempotencyCacheOps.inc({ operation: 'cleanup', result: 'success' });
        } catch (err) {
          logger.error({ error: err, idempotencyKey }, 'Failed to cleanup idempotency lock');
        }
      };

      // If response is an error (4xx/5xx), clear the lock to allow retry
      res.on('finish', () => {
        if (res.statusCode >= 400) {
          cleanup();
        }
      });

      next();
    } catch (error) {
      logger.error({ error, idempotencyKey }, 'Idempotency middleware error');
      // On Redis errors, allow request to proceed (fail-open)
      // but log for monitoring
      idempotencyCacheOps.inc({ operation: 'check', result: 'error' });
      next();
    }
  };
}

/**
 * Helper to generate idempotency key for client usage.
 * Combines user ID, timestamp, and random suffix for uniqueness.
 */
export function generateIdempotencyKey(prefix: string = 'txn'): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 10);
  return `${prefix}_${timestamp}_${random}`;
}

/**
 * Decorator for service methods that need idempotency.
 * Use when idempotency needs to be enforced at service layer.
 */
export async function executeIdempotent<T>(
  idempotencyKey: string,
  operation: () => Promise<T>,
  ttlSeconds: number = 86400
): Promise<{ result: T; replayed: boolean }> {
  const cacheKey = `idempotency:service:${idempotencyKey}`;

  // Check cache
  const cached = await redis.get(cacheKey);
  if (cached) {
    const parsed = JSON.parse(cached);
    if (parsed.status === 'completed') {
      return { result: parsed.result as T, replayed: true };
    }
    if (parsed.status === 'in_progress') {
      throw new Error('Operation already in progress');
    }
  }

  // Acquire lock
  const lockAcquired = await redis.set(
    cacheKey,
    JSON.stringify({ status: 'in_progress', startedAt: Date.now() }),
    'EX',
    60,
    'NX'
  );

  if (!lockAcquired) {
    throw new Error('Operation already in progress');
  }

  try {
    const result = await operation();

    // Cache result
    await redis.set(
      cacheKey,
      JSON.stringify({ status: 'completed', result, completedAt: Date.now() }),
      'EX',
      ttlSeconds
    );

    return { result, replayed: false };
  } catch (error) {
    // Clear lock on error
    await redis.del(cacheKey);
    throw error;
  }
}

export default idempotencyMiddleware;
