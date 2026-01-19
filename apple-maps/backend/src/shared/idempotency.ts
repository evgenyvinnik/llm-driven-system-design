import redis from '../redis.js';
import logger from './logger.js';
import { idempotencyHits, idempotencyMisses } from './metrics.js';
import type { Request, Response, NextFunction } from 'express';

/**
 * Idempotency Module
 *
 * WHY: Idempotency ensures that:
 * - Retry-safe operations: Network failures can be safely retried
 * - Exactly-once semantics: Prevents duplicate processing
 * - Consistent results: Same request always returns same response
 * - Client simplicity: Clients don't need complex retry logic
 *
 * Implementation:
 * - Uses Redis for distributed idempotency key storage
 * - TTL-based expiration for automatic cleanup
 * - Stores both status and result for replay
 */

const DEFAULT_TTL_SECONDS = 86400; // 24 hours
const PROCESSING_TIMEOUT_SECONDS = 60; // Lock timeout for in-progress requests

/**
 * Idempotency states
 */
const IdempotencyState = {
  PROCESSING: 'processing',
  COMPLETED: 'completed',
  FAILED: 'failed',
} as const;

type IdempotencyStateType = typeof IdempotencyState[keyof typeof IdempotencyState];

interface IdempotencyData {
  state: IdempotencyStateType;
  startedAt?: number;
  result?: unknown;
  statusCode?: number;
  completedAt?: number;
  error?: string;
  failedAt?: number;
}

interface IdempotencyCheckResult {
  isProcessing?: boolean;
  isReplay?: boolean;
  retryAfter?: number;
  result?: unknown;
  statusCode?: number;
}

interface IdempotencyInfo {
  operation: string;
  key: string;
}

interface RequestWithIdempotency extends Request {
  idempotency?: IdempotencyInfo;
}

/**
 * Generate a cache key for idempotency
 */
function getIdempotencyKey(operation: string, idempotencyKey: string): string {
  return `idempotency:${operation}:${idempotencyKey}`;
}

/**
 * Check if a request is a replay and return cached result
 */
async function checkIdempotency(
  operation: string,
  idempotencyKey: string
): Promise<IdempotencyCheckResult | null> {
  if (!idempotencyKey) {
    return null; // No idempotency key provided
  }

  const key = getIdempotencyKey(operation, idempotencyKey);

  try {
    const cached = await redis.get(key);

    if (cached) {
      const data: IdempotencyData = JSON.parse(cached);

      if (data.state === IdempotencyState.PROCESSING) {
        // Request still processing - could be concurrent duplicate or previous failure
        const elapsedMs = Date.now() - (data.startedAt || 0);
        if (elapsedMs < PROCESSING_TIMEOUT_SECONDS * 1000) {
          // Still within timeout - tell client to retry later
          idempotencyHits.inc({ operation });
          logger.debug({ operation, idempotencyKey }, 'Idempotency: request still processing');
          return {
            isProcessing: true,
            retryAfter: Math.ceil((PROCESSING_TIMEOUT_SECONDS * 1000 - elapsedMs) / 1000),
          };
        }
        // Timeout expired - treat as new request
        logger.warn(
          { operation, idempotencyKey },
          'Idempotency: previous processing timed out, allowing retry'
        );
        return null;
      }

      if (data.state === IdempotencyState.COMPLETED) {
        idempotencyHits.inc({ operation });
        logger.debug({ operation, idempotencyKey }, 'Idempotency: returning cached result');
        return {
          isReplay: true,
          result: data.result,
          statusCode: data.statusCode,
        };
      }

      if (data.state === IdempotencyState.FAILED) {
        // Previous request failed - allow retry
        logger.debug({ operation, idempotencyKey }, 'Idempotency: previous attempt failed, allowing retry');
        return null;
      }
    }

    return null; // Not found = new request
  } catch (error) {
    logger.error({ error, operation, idempotencyKey }, 'Idempotency check failed');
    return null; // Fail open - allow the request
  }
}

/**
 * Start processing a new idempotent request
 */
async function startIdempotentRequest(
  operation: string,
  idempotencyKey: string,
  ttl: number = DEFAULT_TTL_SECONDS
): Promise<boolean> {
  if (!idempotencyKey) {
    return true; // No idempotency key - proceed normally
  }

  const key = getIdempotencyKey(operation, idempotencyKey);

  try {
    // Use SET NX (only if not exists) to acquire lock
    const result = await redis.set(
      key,
      JSON.stringify({
        state: IdempotencyState.PROCESSING,
        startedAt: Date.now(),
      } as IdempotencyData),
      'EX',
      ttl,
      'NX'
    );

    if (result === 'OK') {
      idempotencyMisses.inc({ operation });
      logger.debug({ operation, idempotencyKey }, 'Idempotency: started new request');
      return true;
    }

    // Key already exists
    logger.debug({ operation, idempotencyKey }, 'Idempotency: key already exists');
    return false;
  } catch (error) {
    logger.error({ error, operation, idempotencyKey }, 'Idempotency start failed');
    return true; // Fail open
  }
}

/**
 * Complete an idempotent request with success
 */
async function completeIdempotentRequest(
  operation: string,
  idempotencyKey: string,
  result: unknown,
  statusCode: number = 200,
  ttl: number = DEFAULT_TTL_SECONDS
): Promise<void> {
  if (!idempotencyKey) {
    return;
  }

  const key = getIdempotencyKey(operation, idempotencyKey);

  try {
    await redis.setex(
      key,
      ttl,
      JSON.stringify({
        state: IdempotencyState.COMPLETED,
        result,
        statusCode,
        completedAt: Date.now(),
      } as IdempotencyData)
    );
    logger.debug({ operation, idempotencyKey }, 'Idempotency: completed successfully');
  } catch (error) {
    logger.error({ error, operation, idempotencyKey }, 'Idempotency completion failed');
  }
}

/**
 * Mark an idempotent request as failed
 */
async function failIdempotentRequest(
  operation: string,
  idempotencyKey: string,
  errorMessage: string
): Promise<void> {
  if (!idempotencyKey) {
    return;
  }

  const key = getIdempotencyKey(operation, idempotencyKey);

  try {
    // Set with short TTL to allow retries
    await redis.setex(
      key,
      PROCESSING_TIMEOUT_SECONDS,
      JSON.stringify({
        state: IdempotencyState.FAILED,
        error: errorMessage,
        failedAt: Date.now(),
      } as IdempotencyData)
    );
    logger.debug({ operation, idempotencyKey }, 'Idempotency: marked as failed');
  } catch (error) {
    logger.error({ error, operation, idempotencyKey }, 'Idempotency failure marking failed');
  }
}

/**
 * Express middleware for idempotent endpoints
 */
function idempotencyMiddleware(operation: string) {
  return async (req: RequestWithIdempotency, res: Response, next: NextFunction): Promise<void> => {
    const idempotencyKey = (req.headers['idempotency-key'] || req.headers['x-idempotency-key']) as string | undefined;

    if (!idempotencyKey) {
      // No idempotency key provided - proceed without protection
      next();
      return;
    }

    // Check for existing result
    const existing = await checkIdempotency(operation, idempotencyKey);

    if (existing?.isProcessing) {
      res.status(409).json({
        error: 'Request still processing',
        retryAfter: existing.retryAfter,
      });
      return;
    }

    if (existing?.isReplay) {
      res.status(existing.statusCode || 200).json(existing.result);
      return;
    }

    // Try to acquire lock
    const acquired = await startIdempotentRequest(operation, idempotencyKey);
    if (!acquired) {
      // Race condition - another request got the lock
      res.status(409).json({
        error: 'Duplicate request in progress',
        retryAfter: 5,
      });
      return;
    }

    // Store idempotency info on request for later completion
    req.idempotency = {
      operation,
      key: idempotencyKey,
    };

    // Override res.json to capture the response
    const originalJson = res.json.bind(res);
    res.json = function (data: unknown) {
      if (req.idempotency && res.statusCode < 500) {
        void completeIdempotentRequest(
          req.idempotency.operation,
          req.idempotency.key,
          data,
          res.statusCode
        );
      } else if (req.idempotency) {
        void failIdempotentRequest(
          req.idempotency.operation,
          req.idempotency.key,
          (data as { error?: string })?.error || 'Unknown error'
        );
      }
      return originalJson(data);
    };

    next();
  };
}

export {
  checkIdempotency,
  startIdempotentRequest,
  completeIdempotentRequest,
  failIdempotentRequest,
  idempotencyMiddleware,
  IdempotencyState,
};
export type { IdempotencyCheckResult, IdempotencyInfo, RequestWithIdempotency };
