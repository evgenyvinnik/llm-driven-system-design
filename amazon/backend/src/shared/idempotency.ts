/**
 * Idempotency Key Handling for Order Placement
 *
 * Prevents duplicate orders from:
 * - Network retries
 * - User double-clicking checkout
 * - Client-side retry logic
 *
 * Uses Redis for fast lookups with TTL, with PostgreSQL fallback for durability.
 */
import crypto from 'crypto';
import { Request, Response, NextFunction } from 'express';
import { getRedis } from '../services/redis.js';
import { query } from '../services/database.js';
import logger, { LogEvents } from './logger.js';
import { idempotencyHitsTotal } from './metrics.js';

// Extend Request to include idempotencyKey
interface ExtendedRequest extends Request {
  idempotencyKey?: string;
}

// Idempotency key TTL (24 hours by default)
const IDEMPOTENCY_TTL_SECONDS = parseInt(process.env.IDEMPOTENCY_TTL_SECONDS || '86400');

// Redis key prefix
const REDIS_PREFIX = 'idempotency:';

/**
 * Idempotency record structure
 */
interface IdempotencyRecord {
  key: string;
  status: 'processing' | 'completed' | 'failed';
  response: unknown;
  requestData?: unknown;
  createdAt: number;
  completedAt: number | null;
}

interface IdempotencyResult {
  isDuplicate: boolean;
  isProcessing?: boolean;
  response?: unknown;
}

interface IdempotencyDBRow {
  key: string;
  status: string;
  response: unknown;
  request_data: unknown;
  created_at: Date;
  completed_at: Date | null;
}

/**
 * Generate an idempotency key for a request
 * Client should generate this, but we provide a fallback
 */
export function generateIdempotencyKey(req: ExtendedRequest): string {
  // Client-provided key takes precedence
  if (req.headers['idempotency-key']) {
    return req.headers['idempotency-key'] as string;
  }

  if (req.headers['x-idempotency-key']) {
    return req.headers['x-idempotency-key'] as string;
  }

  // Fallback: Generate from user ID + timestamp + random
  // This is less ideal as it doesn't prevent double-clicks
  const userId = req.user?.id || 'anonymous';
  return `${userId}-${Date.now()}-${crypto.randomBytes(8).toString('hex')}`;
}

/**
 * Check if an idempotency key exists and return cached response if available
 */
export async function getIdempotencyRecord(key: string): Promise<IdempotencyRecord | null> {
  try {
    const redis = getRedis();
    const redisKey = `${REDIS_PREFIX}${key}`;

    // Try Redis first (fast)
    const cached = await redis.get(redisKey);
    if (cached) {
      const record: IdempotencyRecord = JSON.parse(cached);
      logger.debug({ key, status: record.status }, 'Idempotency key found in Redis');
      return record;
    }

    // Fallback to PostgreSQL for durability
    const result = await query<IdempotencyDBRow>(
      'SELECT * FROM idempotency_keys WHERE key = $1',
      [key]
    );

    if (result.rows.length > 0) {
      const dbRecord = result.rows[0];
      const record: IdempotencyRecord = {
        key: dbRecord.key,
        status: dbRecord.status as IdempotencyRecord['status'],
        response: dbRecord.response,
        createdAt: new Date(dbRecord.created_at).getTime(),
        completedAt: dbRecord.completed_at ? new Date(dbRecord.completed_at).getTime() : null
      };

      // Cache in Redis for faster subsequent lookups
      await redis.set(redisKey, JSON.stringify(record), { EX: IDEMPOTENCY_TTL_SECONDS });

      logger.debug({ key, status: record.status }, 'Idempotency key found in PostgreSQL');
      return record;
    }

    return null;
  } catch (error) {
    const err = error as Error;
    logger.error({ key, error: err.message }, 'Error checking idempotency key');
    // On error, return null to allow the request to proceed
    // This is a trade-off: better to risk duplicate than block all requests
    return null;
  }
}

/**
 * Create a new idempotency record in 'processing' state
 * Uses Redis SETNX for atomic check-and-set
 */
export async function createIdempotencyRecord(
  key: string,
  requestData: unknown = {}
): Promise<boolean> {
  try {
    const redis = getRedis();
    const redisKey = `${REDIS_PREFIX}${key}`;

    const record: IdempotencyRecord = {
      key,
      status: 'processing',
      response: null,
      requestData,
      createdAt: Date.now(),
      completedAt: null
    };

    // Atomic set-if-not-exists in Redis
    const result = await redis.set(redisKey, JSON.stringify(record), {
      NX: true, // Only set if not exists
      EX: IDEMPOTENCY_TTL_SECONDS
    });

    if (result === null) {
      // Key already exists
      logger.info({ key }, 'Idempotency key already exists (duplicate request)');
      return false;
    }

    // Also store in PostgreSQL for durability
    try {
      await query(
        `INSERT INTO idempotency_keys (key, status, request_data, created_at)
         VALUES ($1, $2, $3, NOW())
         ON CONFLICT (key) DO NOTHING`,
        [key, 'processing', JSON.stringify(requestData)]
      );
    } catch (dbError) {
      const err = dbError as Error;
      // PostgreSQL insert failed, but Redis succeeded
      // Log warning but continue - Redis is primary
      logger.warn({ key, error: err.message }, 'Failed to store idempotency key in PostgreSQL');
    }

    logger.debug({ key }, 'Created idempotency record');
    return true;
  } catch (error) {
    const err = error as Error;
    logger.error({ key, error: err.message }, 'Error creating idempotency record');
    // On error, return true to allow request to proceed
    return true;
  }
}

/**
 * Complete an idempotency record with response
 */
export async function completeIdempotencyRecord(
  key: string,
  status: 'completed' | 'failed',
  response: unknown
): Promise<void> {
  try {
    const redis = getRedis();
    const redisKey = `${REDIS_PREFIX}${key}`;

    const record: IdempotencyRecord = {
      key,
      status,
      response,
      createdAt: Date.now(), // Will be overwritten if exists
      completedAt: Date.now()
    };

    // Update Redis
    await redis.set(redisKey, JSON.stringify(record), { EX: IDEMPOTENCY_TTL_SECONDS });

    // Update PostgreSQL
    await query(
      `UPDATE idempotency_keys
       SET status = $1, response = $2, completed_at = NOW()
       WHERE key = $3`,
      [status, JSON.stringify(response), key]
    );

    logger.debug({ key, status }, 'Completed idempotency record');
  } catch (error) {
    const err = error as Error;
    logger.error({ key, error: err.message }, 'Error completing idempotency record');
  }
}

/**
 * Middleware for idempotency handling
 * Attaches idempotency functions to request object
 */
export function idempotencyMiddleware(
  req: ExtendedRequest,
  res: Response,
  next: NextFunction
): void {
  // Only apply to POST/PUT/PATCH requests
  if (!['POST', 'PUT', 'PATCH'].includes(req.method)) {
    next();
    return;
  }

  // Extract idempotency key from headers
  const idempotencyKey = (req.headers['idempotency-key'] as string) || (req.headers['x-idempotency-key'] as string);

  if (idempotencyKey) {
    req.idempotencyKey = idempotencyKey;
  }

  next();
}

/**
 * Handle idempotent order placement
 * Returns cached response if duplicate, otherwise allows request
 */
export async function handleIdempotentOrder(req: ExtendedRequest): Promise<IdempotencyResult> {
  const key = req.idempotencyKey || generateIdempotencyKey(req);

  // Check for existing record
  const existingRecord = await getIdempotencyRecord(key);

  if (existingRecord) {
    // Record exists
    if (existingRecord.status === 'processing') {
      // Request is still being processed - likely a race condition
      logger.warn({ key }, 'Idempotent request still processing');
      return {
        isDuplicate: true,
        isProcessing: true,
        response: { error: 'Request is still being processed', retryAfter: 5 }
      };
    }

    if (existingRecord.status === 'completed') {
      // Return cached successful response
      logger.info({ key, event: LogEvents.IDEMPOTENCY_HIT }, 'Returning cached order response');
      idempotencyHitsTotal.inc();
      return {
        isDuplicate: true,
        isProcessing: false,
        response: existingRecord.response
      };
    }

    if (existingRecord.status === 'failed') {
      // Previous request failed - allow retry with same key
      logger.info({ key }, 'Previous request failed, allowing retry');
      // Update record to processing
      await createIdempotencyRecord(key, { body: req.body, userId: req.user?.id });
      return { isDuplicate: false };
    }
  }

  // No existing record - create new one
  const created = await createIdempotencyRecord(key, {
    body: req.body,
    userId: req.user?.id
  });

  if (!created) {
    // Race condition - another request created the record
    const record = await getIdempotencyRecord(key);
    if (record?.status === 'completed') {
      idempotencyHitsTotal.inc();
      return {
        isDuplicate: true,
        isProcessing: false,
        response: record.response
      };
    }
    return {
      isDuplicate: true,
      isProcessing: true,
      response: { error: 'Request is being processed', retryAfter: 5 }
    };
  }

  // Store key in request for later completion
  req.idempotencyKey = key;
  return { isDuplicate: false };
}

/**
 * Complete order with idempotency record update
 */
export async function completeIdempotentOrder(req: ExtendedRequest, order: unknown): Promise<void> {
  if (req.idempotencyKey) {
    await completeIdempotencyRecord(req.idempotencyKey, 'completed', { order });
  }
}

/**
 * Mark order creation as failed
 */
export async function failIdempotentOrder(req: ExtendedRequest, error: Error): Promise<void> {
  if (req.idempotencyKey) {
    await completeIdempotencyRecord(req.idempotencyKey, 'failed', {
      error: error.message,
      code: (error as Error & { code?: string }).code
    });
  }
}

/**
 * Cleanup expired idempotency keys from PostgreSQL
 * Run as a scheduled job
 */
export async function cleanupExpiredIdempotencyKeys(): Promise<number> {
  try {
    const cutoffDate = new Date(Date.now() - IDEMPOTENCY_TTL_SECONDS * 1000);

    const result = await query(
      'DELETE FROM idempotency_keys WHERE created_at < $1',
      [cutoffDate]
    );

    logger.info({ deleted: result.rowCount }, 'Cleaned up expired idempotency keys');
    return result.rowCount || 0;
  } catch (error) {
    const err = error as Error;
    logger.error({ error: err.message }, 'Error cleaning up idempotency keys');
    throw error;
  }
}

export default {
  generateIdempotencyKey,
  getIdempotencyRecord,
  createIdempotencyRecord,
  completeIdempotencyRecord,
  idempotencyMiddleware,
  handleIdempotentOrder,
  completeIdempotentOrder,
  failIdempotentOrder,
  cleanupExpiredIdempotencyKeys
};
