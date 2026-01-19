import { Request, Response, NextFunction } from 'express';
import redis from '../services/redis.js';
import { idempotencyKeyHits } from './metrics.js';
import { createLogger } from './logger.js';

const logger = createLogger('idempotency');

// Idempotency key TTL in seconds (24 hours by default)
const IDEMPOTENCY_KEY_TTL = 24 * 60 * 60;

// Key prefix for idempotency storage
const IDEMPOTENCY_PREFIX = 'idempotency:';

// Possible states for idempotency keys
export const IdempotencyState = {
  PROCESSING: 'processing',
  COMPLETED: 'completed',
  FAILED: 'failed',
} as const;

type IdempotencyStateType = typeof IdempotencyState[keyof typeof IdempotencyState];

interface IdempotencyKeyResult {
  exists: boolean;
  state?: IdempotencyStateType;
  result?: unknown;
  statusCode?: number;
}

interface IdempotencyMiddlewareOptions {
  required?: boolean;
  methods?: string[];
}

// Extend Express Request to include idempotencyKey
declare global {
  namespace Express {
    interface Request {
      idempotencyKey?: string;
    }
  }
}

/**
 * Check if an idempotency key exists and get its result
 * @param key - The idempotency key (usually from Idempotency-Key header)
 * @returns Object containing exists flag and optional state/result
 */
export async function checkIdempotencyKey(key: string): Promise<IdempotencyKeyResult> {
  try {
    const data = await redis.get(`${IDEMPOTENCY_PREFIX}${key}`);
    if (!data) {
      return { exists: false };
    }

    const parsed = JSON.parse(data);
    idempotencyKeyHits.inc();
    logger.info({ key, state: parsed.state }, 'Idempotency key hit');

    return {
      exists: true,
      state: parsed.state,
      result: parsed.result,
      statusCode: parsed.statusCode,
    };
  } catch (error) {
    logger.error({ error, key }, 'Error checking idempotency key');
    return { exists: false };
  }
}

/**
 * Start processing for an idempotency key
 * Acquires a lock to prevent concurrent processing
 * @param key - The idempotency key
 * @param lockTtl - Lock TTL in seconds (default 60s)
 * @returns True if lock acquired, false if already processing
 */
export async function startIdempotentOperation(key: string, lockTtl: number = 60): Promise<boolean> {
  try {
    const fullKey = `${IDEMPOTENCY_PREFIX}${key}`;

    // Try to set with NX (only if not exists)
    const acquired = await redis.set(
      fullKey,
      JSON.stringify({ state: IdempotencyState.PROCESSING, startedAt: new Date().toISOString() }),
      'EX',
      lockTtl,
      'NX'
    );

    if (acquired) {
      logger.info({ key }, 'Idempotent operation started');
      return true;
    }

    logger.debug({ key }, 'Idempotent operation already in progress');
    return false;
  } catch (error) {
    logger.error({ error, key }, 'Error starting idempotent operation');
    return false;
  }
}

/**
 * Complete an idempotent operation with its result
 * @param key - The idempotency key
 * @param result - The result to store
 * @param statusCode - HTTP status code of the response
 * @param ttl - TTL for storing the result (default 24h)
 */
export async function completeIdempotentOperation(
  key: string,
  result: unknown,
  statusCode: number = 200,
  ttl: number = IDEMPOTENCY_KEY_TTL
): Promise<void> {
  try {
    const fullKey = `${IDEMPOTENCY_PREFIX}${key}`;
    const data = {
      state: IdempotencyState.COMPLETED,
      result,
      statusCode,
      completedAt: new Date().toISOString(),
    };

    await redis.setex(fullKey, ttl, JSON.stringify(data));
    logger.info({ key, statusCode }, 'Idempotent operation completed');
  } catch (error) {
    logger.error({ error, key }, 'Error completing idempotent operation');
  }
}

/**
 * Mark an idempotent operation as failed
 * Clears the key so it can be retried
 * @param key - The idempotency key
 * @param errorMsg - Error message
 */
export async function failIdempotentOperation(key: string, errorMsg: string): Promise<void> {
  try {
    const fullKey = `${IDEMPOTENCY_PREFIX}${key}`;
    // Delete the key to allow retry
    await redis.del(fullKey);
    logger.warn({ key, error: errorMsg }, 'Idempotent operation failed, key cleared for retry');
  } catch (err) {
    logger.error({ error: err, key }, 'Error failing idempotent operation');
  }
}

/**
 * Express middleware for idempotency
 * Requires Idempotency-Key header for POST/PUT/DELETE requests
 * @param options - Middleware options
 * @returns Express middleware
 */
export function idempotencyMiddleware(options: IdempotencyMiddlewareOptions = {}): (req: Request, res: Response, next: NextFunction) => Promise<void | Response> {
  const { required = false, methods = ['POST'] } = options;

  return async (req: Request, res: Response, next: NextFunction): Promise<void | Response> => {
    // Only check specified methods
    if (!methods.includes(req.method)) {
      return next();
    }

    const idempotencyKey = req.headers['idempotency-key'] as string | undefined;

    // If no key provided
    if (!idempotencyKey) {
      if (required) {
        return res.status(400).json({
          error: 'Idempotency-Key header is required for this request',
        });
      }
      return next();
    }

    // Check if key already exists
    const existing = await checkIdempotencyKey(idempotencyKey);

    if (existing.exists) {
      if (existing.state === IdempotencyState.PROCESSING) {
        // Request is still being processed
        return res.status(409).json({
          error: 'Request with this idempotency key is still being processed',
          retryAfter: 5,
        });
      }

      if (existing.state === IdempotencyState.COMPLETED) {
        // Return cached result
        logger.info({ key: idempotencyKey }, 'Returning cached idempotent response');
        return res.status(existing.statusCode || 200).json(existing.result);
      }
    }

    // Try to acquire lock
    const acquired = await startIdempotentOperation(idempotencyKey);
    if (!acquired) {
      return res.status(409).json({
        error: 'Concurrent request with same idempotency key detected',
        retryAfter: 5,
      });
    }

    // Store key on request for later use
    req.idempotencyKey = idempotencyKey;

    // Wrap res.json to capture the response
    const originalJson = res.json.bind(res);
    res.json = (data: unknown) => {
      // Store the result if successful
      if (res.statusCode >= 200 && res.statusCode < 300) {
        completeIdempotentOperation(idempotencyKey, data, res.statusCode).catch((err) => {
          logger.error({ error: err }, 'Failed to complete idempotent operation');
        });
      } else {
        // Failed request, allow retry
        failIdempotentOperation(idempotencyKey, 'Request failed').catch((err) => {
          logger.error({ error: err }, 'Failed to fail idempotent operation');
        });
      }
      return originalJson(data);
    };

    next();
  };
}

/**
 * Generate an idempotency key for client-side use
 * Based on user ID and operation details
 * @param userId - User ID
 * @param operation - Operation type (e.g., 'checkout')
 * @param details - Additional details (e.g., cart hash)
 * @returns Generated idempotency key
 */
export function generateIdempotencyKey(userId: number, operation: string, details: string = ''): string {
  const timestamp = Math.floor(Date.now() / 60000); // 1-minute granularity
  return `${userId}:${operation}:${details}:${timestamp}`;
}

export default {
  checkIdempotencyKey,
  startIdempotentOperation,
  completeIdempotentOperation,
  failIdempotentOperation,
  idempotencyMiddleware,
  generateIdempotencyKey,
  IdempotencyState,
};
