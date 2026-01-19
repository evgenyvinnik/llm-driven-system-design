import redisClient from '../redis.js';
import logger from './logger.js';
import { idempotencyHits } from './metrics.js';
import type { Request, Response, NextFunction } from 'express';

/**
 * Default TTL for idempotency keys (24 hours)
 */
const DEFAULT_TTL = 86400;

/**
 * Idempotency key prefixes
 */
export const IDEMPOTENCY_KEYS = {
  ORDER_CREATE: 'idempotency:order:create:',
  PAYMENT: 'idempotency:payment:',
  STATUS_CHANGE: 'idempotency:status:',
} as const;

/**
 * Response status indicating idempotency state
 */
export const IdempotencyStatus = {
  NEW: 'new', // First request with this key
  IN_PROGRESS: 'in_progress', // Request is being processed
  COMPLETED: 'completed', // Request completed, returning cached response
} as const;

export type IdempotencyStatusType = (typeof IdempotencyStatus)[keyof typeof IdempotencyStatus];

export interface IdempotencyResponse {
  statusCode: number;
  body: unknown;
}

export interface IdempotencyCheckResult {
  status: IdempotencyStatusType;
  response: IdempotencyResponse | null;
}

interface CachedIdempotencyData {
  inProgress: boolean;
  response?: IdempotencyResponse;
  startedAt?: number;
  completedAt?: number;
}

// Extend Express Request to include idempotency properties
declare global {
  namespace Express {
    interface Request {
      idempotencyKey?: string;
      idempotencyPrefix?: string;
    }
  }
}

/**
 * Check if an idempotency key exists and get cached response
 */
export async function checkIdempotency(
  prefix: string,
  key: string | undefined
): Promise<IdempotencyCheckResult> {
  if (!key) {
    return { status: IdempotencyStatus.NEW, response: null };
  }

  const fullKey = `${prefix}${key}`;

  try {
    const cached = await redisClient.get(fullKey);

    if (!cached) {
      // No existing request with this key
      return { status: IdempotencyStatus.NEW, response: null };
    }

    const data: CachedIdempotencyData = JSON.parse(cached);

    if (data.inProgress) {
      // Request is still being processed
      return { status: IdempotencyStatus.IN_PROGRESS, response: null };
    }

    // Request completed, return cached response
    idempotencyHits.inc({ operation: prefix.replace(/^idempotency:|:$/g, '') });
    logger.info({ key: fullKey }, 'Idempotency cache hit - returning cached response');

    return {
      status: IdempotencyStatus.COMPLETED,
      response: data.response || null,
    };
  } catch (error) {
    const err = error as Error;
    logger.warn({ error: err.message, key: fullKey }, 'Idempotency check error');
    // On error, treat as new request
    return { status: IdempotencyStatus.NEW, response: null };
  }
}

/**
 * Mark an idempotency key as in-progress
 * This prevents duplicate processing if a second request arrives before the first completes
 */
export async function markInProgress(
  prefix: string,
  key: string | undefined,
  ttl: number = 60
): Promise<boolean> {
  if (!key) return true;

  const fullKey = `${prefix}${key}`;

  try {
    // Use NX (only set if not exists) to prevent race conditions
    const result = await redisClient.set(
      fullKey,
      JSON.stringify({ inProgress: true, startedAt: Date.now() }),
      { NX: true, EX: ttl }
    );

    return result !== null;
  } catch (error) {
    const err = error as Error;
    logger.warn({ error: err.message, key: fullKey }, 'Failed to mark idempotency in-progress');
    return true; // Allow processing on error
  }
}

/**
 * Store the completed response for an idempotency key
 */
export async function storeIdempotencyResponse(
  prefix: string,
  key: string | undefined,
  response: IdempotencyResponse,
  ttl: number = DEFAULT_TTL
): Promise<void> {
  if (!key) return;

  const fullKey = `${prefix}${key}`;

  try {
    await redisClient.setEx(
      fullKey,
      ttl,
      JSON.stringify({
        inProgress: false,
        response,
        completedAt: Date.now(),
      })
    );

    logger.debug({ key: fullKey }, 'Idempotency response stored');
  } catch (error) {
    const err = error as Error;
    logger.warn({ error: err.message, key: fullKey }, 'Failed to store idempotency response');
  }
}

/**
 * Clear an idempotency key (used when request fails and should be retryable)
 */
export async function clearIdempotencyKey(prefix: string, key: string | undefined): Promise<void> {
  if (!key) return;

  const fullKey = `${prefix}${key}`;

  try {
    await redisClient.del(fullKey);
    logger.debug({ key: fullKey }, 'Idempotency key cleared');
  } catch (error) {
    const err = error as Error;
    logger.warn({ error: err.message, key: fullKey }, 'Failed to clear idempotency key');
  }
}

/**
 * Express middleware to enforce idempotency for a specific operation
 */
export function idempotencyMiddleware(
  prefix: string
): (req: Request, res: Response, next: NextFunction) => Promise<void> {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const idempotencyKey = req.headers['x-idempotency-key'] as string | undefined;

    if (!idempotencyKey) {
      // Idempotency key required for this operation
      res.status(400).json({
        error: 'Missing X-Idempotency-Key header',
        message: 'This operation requires an idempotency key to prevent duplicate processing',
      });
      return;
    }

    // Check for existing request
    const { status, response } = await checkIdempotency(prefix, idempotencyKey);

    if (status === IdempotencyStatus.COMPLETED && response) {
      // Return cached response
      res.status(response.statusCode).json(response.body);
      return;
    }

    if (status === IdempotencyStatus.IN_PROGRESS) {
      // Request is already being processed
      res.status(409).json({
        error: 'Request in progress',
        message: 'A request with this idempotency key is currently being processed',
      });
      return;
    }

    // Mark as in-progress
    const marked = await markInProgress(prefix, idempotencyKey);
    if (!marked) {
      // Race condition - another request started processing
      res.status(409).json({
        error: 'Request in progress',
        message: 'A request with this idempotency key is currently being processed',
      });
      return;
    }

    // Attach idempotency key to request for later storage
    req.idempotencyKey = idempotencyKey;
    req.idempotencyPrefix = prefix;

    // Wrap res.json to capture and store the response
    const originalJson = res.json.bind(res);
    res.json = ((body: unknown): Response => {
      // Store response for future identical requests
      storeIdempotencyResponse(prefix, idempotencyKey, {
        statusCode: res.statusCode,
        body,
      });
      return originalJson(body);
    }) as Response['json'];

    next();
  };
}

export default {
  IDEMPOTENCY_KEYS,
  IdempotencyStatus,
  checkIdempotency,
  markInProgress,
  storeIdempotencyResponse,
  clearIdempotencyKey,
  idempotencyMiddleware,
};
