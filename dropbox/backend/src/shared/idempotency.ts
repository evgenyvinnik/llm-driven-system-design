/**
 * Idempotency middleware for ensuring at-most-once semantics.
 * Prevents duplicate file operations when clients retry requests.
 * Uses Redis to track request state with TTL-based cleanup.
 * @module shared/idempotency
 */

import { Request, Response, NextFunction } from 'express';
import { redis } from '../utils/redis.js';
import { logger } from './logger.js';
import { idempotencyCacheHits, idempotencyCacheMisses } from './metrics.js';
import crypto from 'crypto';

/**
 * Idempotency key header name.
 * Clients should provide this header for operations that should be idempotent.
 */
export const IDEMPOTENCY_KEY_HEADER = 'idempotency-key';

/**
 * Default TTL for idempotency records in seconds.
 * Records older than this are automatically cleaned up.
 */
const DEFAULT_TTL_SECONDS = 24 * 60 * 60; // 24 hours

/**
 * Prefix for Redis idempotency keys
 */
const REDIS_PREFIX = 'idempotency:';

/**
 * Possible states for an idempotent request
 */
enum IdempotencyState {
  /** Request is in progress */
  Processing = 'processing',
  /** Request completed successfully */
  Completed = 'completed',
  /** Request failed */
  Failed = 'failed',
}

/**
 * Stored idempotency record
 */
interface IdempotencyRecord {
  state: IdempotencyState;
  statusCode?: number;
  body?: string;
  createdAt: string;
  completedAt?: string;
}

/**
 * WHY idempotency enables reliable chunked uploads:
 *
 * 1. Network failures are common - clients may not receive the response even
 *    when the server successfully processed the request.
 *
 * 2. Chunk uploads modify state (reference counts, storage) - replaying them
 *    without idempotency would corrupt data or waste storage.
 *
 * 3. Clients can safely retry any request with the same idempotency key
 *    and get the same response, enabling "at-most-once" semantics.
 *
 * 4. Resumable uploads work correctly even with unreliable networks -
 *    clients can retry individual chunk uploads without fear of duplication.
 *
 * Implementation details:
 * - Uses Redis for distributed state (works across multiple API servers)
 * - Records are locked during processing to prevent concurrent duplicates
 * - TTL-based cleanup prevents unbounded memory growth
 * - Includes the response body for completed requests
 */

/**
 * Generates an idempotency key from request properties.
 * Used when client doesn't provide an explicit key.
 * @param req - Express request
 * @returns Generated idempotency key
 */
function generateIdempotencyKey(req: Request): string {
  const userId = (req as any).user?.id || 'anonymous';
  const content = `${userId}:${req.method}:${req.path}:${JSON.stringify(req.body)}`;
  return crypto.createHash('sha256').update(content).digest('hex').substring(0, 32);
}

/**
 * Gets the Redis key for an idempotency record
 */
function getRedisKey(key: string, operation: string): string {
  return `${REDIS_PREFIX}${operation}:${key}`;
}

/**
 * Middleware factory for idempotent operations.
 *
 * @param operation - Name of the operation (for metrics and key namespacing)
 * @param options - Configuration options
 * @returns Express middleware
 */
export function idempotent(
  operation: string,
  options: {
    /** TTL in seconds for idempotency records */
    ttlSeconds?: number;
    /** Whether to require an explicit idempotency key header */
    requireKey?: boolean;
    /** Whether to include response body in cache (disable for large responses) */
    cacheBody?: boolean;
  } = {}
) {
  const {
    ttlSeconds = DEFAULT_TTL_SECONDS,
    requireKey = false,
    cacheBody = true,
  } = options;

  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    // Get or generate idempotency key
    let idempotencyKey = req.headers[IDEMPOTENCY_KEY_HEADER] as string | undefined;

    if (!idempotencyKey) {
      if (requireKey) {
        res.status(400).json({
          error: `${IDEMPOTENCY_KEY_HEADER} header is required for this operation`,
        });
        return;
      }
      idempotencyKey = generateIdempotencyKey(req);
    }

    const redisKey = getRedisKey(idempotencyKey, operation);

    try {
      // Try to get existing record
      const existingRecord = await redis.get(redisKey);

      if (existingRecord) {
        const record: IdempotencyRecord = JSON.parse(existingRecord);

        // If still processing, return conflict (another request is handling it)
        if (record.state === IdempotencyState.Processing) {
          logger.warn(
            { operation, idempotencyKey },
            'Duplicate request while processing'
          );
          res.status(409).json({
            error: 'Request is already being processed',
            retryAfter: 5,
          });
          return;
        }

        // If completed, return cached response
        if (record.state === IdempotencyState.Completed) {
          idempotencyCacheHits.labels(operation).inc();
          logger.info(
            { operation, idempotencyKey },
            'Returning cached idempotent response'
          );

          res.status(record.statusCode || 200);
          if (record.body) {
            res.json(JSON.parse(record.body));
          } else {
            res.end();
          }
          return;
        }

        // If failed, allow retry by clearing the record
        if (record.state === IdempotencyState.Failed) {
          await redis.del(redisKey);
        }
      }

      // Mark as processing
      const processingRecord: IdempotencyRecord = {
        state: IdempotencyState.Processing,
        createdAt: new Date().toISOString(),
      };
      await redis.setex(redisKey, ttlSeconds, JSON.stringify(processingRecord));
      idempotencyCacheMisses.labels(operation).inc();

      // Capture original response methods
      const originalJson = res.json.bind(res);
      const originalSend = res.send.bind(res);
      const originalEnd = res.end.bind(res);

      let responseBody: string | undefined;
      let responseCaptured = false;

      // Helper to update idempotency record on completion
      const captureResponse = async (statusCode: number, body?: unknown) => {
        if (responseCaptured) return;
        responseCaptured = true;

        const completedRecord: IdempotencyRecord = {
          state: statusCode >= 200 && statusCode < 400
            ? IdempotencyState.Completed
            : IdempotencyState.Failed,
          statusCode,
          body: cacheBody && body ? JSON.stringify(body) : undefined,
          createdAt: processingRecord.createdAt,
          completedAt: new Date().toISOString(),
        };

        try {
          await redis.setex(redisKey, ttlSeconds, JSON.stringify(completedRecord));
        } catch (error) {
          logger.error(
            { operation, idempotencyKey, error },
            'Failed to update idempotency record'
          );
        }
      };

      // Override response methods to capture response
      res.json = function (body?: any) {
        captureResponse(res.statusCode, body);
        return originalJson(body);
      };

      res.send = function (body?: any) {
        if (typeof body === 'object') {
          captureResponse(res.statusCode, body);
        }
        return originalSend(body);
      };

      res.end = function (chunk?: any, encoding?: any, callback?: any) {
        captureResponse(res.statusCode, undefined);
        return originalEnd(chunk, encoding, callback);
      };

      // Store idempotency key on request for access in route handlers
      (req as any).idempotencyKey = idempotencyKey;

      next();
    } catch (error) {
      logger.error(
        { operation, idempotencyKey, error },
        'Idempotency middleware error'
      );
      // On Redis errors, proceed without idempotency
      next();
    }
  };
}

/**
 * Creates idempotency middleware for upload chunk operations.
 * Chunks are naturally idempotent due to content-addressing,
 * but we still need to prevent duplicate processing.
 */
export const idempotentChunkUpload = idempotent('chunk_upload', {
  ttlSeconds: 24 * 60 * 60, // 24 hours (match upload session TTL)
  requireKey: false,
  cacheBody: true,
});

/**
 * Creates idempotency middleware for upload completion.
 * Critical for preventing duplicate file creation on retry.
 */
export const idempotentUploadComplete = idempotent('upload_complete', {
  ttlSeconds: 24 * 60 * 60,
  requireKey: false,
  cacheBody: true,
});

/**
 * Creates idempotency middleware for file deletion.
 * Prevents double-deletion attempts.
 */
export const idempotentDelete = idempotent('file_delete', {
  ttlSeconds: 1 * 60 * 60, // 1 hour
  requireKey: false,
  cacheBody: true,
});

/**
 * Utility to clear an idempotency record (for testing or error recovery)
 */
export async function clearIdempotencyKey(
  key: string,
  operation: string
): Promise<boolean> {
  const redisKey = getRedisKey(key, operation);
  const deleted = await redis.del(redisKey);
  return deleted > 0;
}
