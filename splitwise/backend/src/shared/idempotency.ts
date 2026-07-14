/**
 * Idempotency middleware for mutating money-adjacent operations.
 *
 * WHY it matters here: a user taps "Add expense" on a flaky connection, the
 * request times out client-side, and the app retries. Without idempotency the
 * same $120 dinner lands twice and every downstream balance is wrong. The same
 * applies to "Settle up". The client sends a stable Idempotency-Key (UUID)
 * generated at tap time; the server processes the first request and replays the
 * stored result for any retry with the same key.
 *
 * Two layers of protection:
 *  1. Redis SET NX (this middleware) — fast, catches near-simultaneous retries.
 *  2. A UNIQUE index on (created_by, idempotency_key) in Postgres — the durable
 *     backstop if Redis is cold or evicted the key.
 */

import type { Request, Response, NextFunction } from 'express';
import { redis } from '../db/redis.js';
import { logger } from './logger.js';
import { idempotencyCacheHits } from './metrics.js';
import type { AuthenticatedRequest } from '../middleware/auth.js';

const IDEMPOTENCY_PREFIX = 'idempotency:';
const IDEMPOTENCY_TTL = 24 * 60 * 60; // 24 hours

export const STATUS = {
  PROCESSING: 'processing',
  COMPLETED: 'completed',
  FAILED: 'failed',
} as const;

export type IdempotencyStatus = typeof STATUS[keyof typeof STATUS];

export interface IdempotencyResponse {
  status: IdempotencyStatus;
  timestamp: number;
  response?: unknown;
  statusCode?: number;
}

export interface IdempotencyOptions {
  required?: boolean;
}

/** Extract the idempotency key from the request headers, if present. */
export function getIdempotencyKey(req: Request): string | null {
  return (
    (req.headers['idempotency-key'] as string | undefined) ||
    (req.headers['x-idempotency-key'] as string | undefined) ||
    null
  );
}

function buildRedisKey(userId: string, key: string, operation: string): string {
  return `${IDEMPOTENCY_PREFIX}${operation}:${userId}:${key}`;
}

interface IdempotencyCheckResult {
  isNew: boolean;
  existingResponse: IdempotencyResponse | null;
}

/**
 * Atomic check-and-set for an idempotency key using Redis SET NX. Only the
 * first concurrent request for a key gets isNew=true; others see the stored
 * state (processing / completed / failed).
 */
export async function checkIdempotency(
  userId: string,
  key: string,
  operation: string
): Promise<IdempotencyCheckResult> {
  const redisKey = buildRedisKey(userId, key, operation);

  const setResult = await redis.set(
    redisKey,
    JSON.stringify({ status: STATUS.PROCESSING, timestamp: Date.now() }),
    'EX',
    IDEMPOTENCY_TTL,
    'NX'
  );

  if (setResult === 'OK') {
    return { isNew: true, existingResponse: null };
  }

  const existingData = await redis.get(redisKey);
  if (!existingData) {
    // Key expired between our SET NX and GET (extremely rare) — retry.
    return checkIdempotency(userId, key, operation);
  }

  const parsed = JSON.parse(existingData) as IdempotencyResponse;
  idempotencyCacheHits.inc();

  logger.info({
    event: 'idempotency_cache_hit',
    userId,
    operation,
    cachedStatus: parsed.status,
  });

  return { isNew: false, existingResponse: parsed };
}

/** Persist the final result for an idempotency key so retries replay it. */
export async function storeIdempotencyResult(
  userId: string,
  key: string,
  operation: string,
  status: IdempotencyStatus,
  response: unknown
): Promise<void> {
  const redisKey = buildRedisKey(userId, key, operation);
  await redis.set(
    redisKey,
    JSON.stringify({ status, timestamp: Date.now(), response }),
    'EX',
    IDEMPOTENCY_TTL
  );
}

/**
 * Express middleware factory. Usage:
 *   router.post('/', authMiddleware, idempotencyMiddleware('expense'), handler)
 */
export function idempotencyMiddleware(operation: string, options: IdempotencyOptions = {}) {
  const { required = false } = options;

  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const idempotencyKey = getIdempotencyKey(req);

    if (!idempotencyKey) {
      if (required) {
        res.status(400).json({
          error: 'Idempotency-Key header is required for this operation',
          code: 'IDEMPOTENCY_KEY_REQUIRED',
        });
        return;
      }
      next();
      return;
    }

    if (idempotencyKey.length < 8 || idempotencyKey.length > 128) {
      res.status(400).json({ error: 'Invalid Idempotency-Key format', code: 'INVALID_IDEMPOTENCY_KEY' });
      return;
    }

    authReq.idempotencyKey = idempotencyKey;

    try {
      const { isNew, existingResponse } = await checkIdempotency(
        authReq.user.id,
        idempotencyKey,
        operation
      );

      if (!isNew && existingResponse) {
        if (existingResponse.status === STATUS.PROCESSING) {
          res.status(409).json({
            error: 'A request with this Idempotency-Key is currently being processed',
            code: 'REQUEST_IN_PROGRESS',
          });
          return;
        }
        if (existingResponse.status === STATUS.COMPLETED) {
          res.status(200).json({ ...(existingResponse.response as object), _cached: true });
          return;
        }
        if (existingResponse.status === STATUS.FAILED) {
          const failed = existingResponse.response as { statusCode?: number };
          res.status(failed?.statusCode || 400).json({ ...(existingResponse.response as object), _cached: true });
          return;
        }
      }

      authReq.storeIdempotencyResult = async (status: string, response: unknown) => {
        await storeIdempotencyResult(
          authReq.user.id,
          idempotencyKey,
          operation,
          status as IdempotencyStatus,
          response
        );
      };

      next();
    } catch (error) {
      // If Redis is unavailable we still process the request — the Postgres
      // unique index on (created_by, idempotency_key) remains as the backstop.
      logger.error({
        event: 'idempotency_redis_failure',
        error: (error as Error).message,
        warning: 'Processing request without Redis idempotency protection',
      });
      authReq.idempotencyFailed = true;
      next();
    }
  };
}
