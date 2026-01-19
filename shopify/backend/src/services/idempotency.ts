import { Request, Response, NextFunction } from 'express';
import { query } from './db.js';
import logger from './logger.js';
import { idempotencyHits, idempotencyMisses } from './metrics.js';

/**
 * Idempotency service for preventing duplicate operations
 * Uses PostgreSQL for durable storage of idempotency keys
 *
 * WHY IDEMPOTENCY MATTERS:
 * 1. Prevents inventory overselling when checkout is retried
 * 2. Ensures exactly-once semantics for order creation
 * 3. Handles network failures and client retries safely
 * 4. Critical for financial operations that cannot be duplicated
 */

// Status values for idempotency records
export const IdempotencyStatus = {
  PROCESSING: 'processing',
  COMPLETED: 'completed',
  FAILED: 'failed',
} as const;

export type IdempotencyStatusType = typeof IdempotencyStatus[keyof typeof IdempotencyStatus];

// Idempotency record interface
interface IdempotencyRecord {
  id: number;
  idempotency_key: string;
  store_id: number;
  operation: string;
  status: IdempotencyStatusType;
  request_params: Record<string, unknown>;
  response_data: Record<string, unknown> | null;
  resource_id: number | null;
  error_message: string | null;
  created_at: Date;
  updated_at: Date;
}

// Idempotency result interface
export interface IdempotencyResult<T> {
  result: T;
  resourceId?: number | null;
  deduplicated: boolean;
}

/**
 * Check if an idempotency key already exists and return its status
 * @param key - Idempotency key
 * @param storeId - Store ID (for tenant isolation)
 * @param operation - Operation type (checkout, inventory_update, etc.)
 * @returns Existing record or null
 */
export async function checkIdempotencyKey(
  key: string,
  storeId: number,
  operation: string
): Promise<IdempotencyRecord | null> {
  try {
    const result = await query(
      `SELECT * FROM idempotency_keys
       WHERE idempotency_key = $1 AND store_id = $2 AND operation = $3`,
      [key, storeId, operation]
    );

    if (result.rows.length > 0) {
      idempotencyHits.inc({ operation });
      logger.debug({ key, storeId, operation }, 'Idempotency key hit');
      return result.rows[0] as IdempotencyRecord;
    }

    idempotencyMisses.inc({ operation });
    return null;
  } catch (error) {
    logger.error({ err: error, key, storeId }, 'Failed to check idempotency key');
    throw error;
  }
}

/**
 * Create or update an idempotency record
 * @param key - Idempotency key
 * @param storeId - Store ID
 * @param operation - Operation type
 * @param status - Processing status
 * @param metadata - Additional metadata (request params, etc.)
 * @returns Created/updated record
 */
export async function createIdempotencyKey(
  key: string,
  storeId: number,
  operation: string,
  status: IdempotencyStatusType = IdempotencyStatus.PROCESSING,
  metadata: Record<string, unknown> = {}
): Promise<IdempotencyRecord> {
  try {
    const result = await query(
      `INSERT INTO idempotency_keys (idempotency_key, store_id, operation, status, request_params, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, NOW(), NOW())
       ON CONFLICT (idempotency_key, store_id, operation)
       DO UPDATE SET status = $4, updated_at = NOW()
       RETURNING *`,
      [key, storeId, operation, status, JSON.stringify(metadata)]
    );

    logger.debug({ key, storeId, operation, status }, 'Idempotency key created/updated');
    return result.rows[0] as IdempotencyRecord;
  } catch (error) {
    logger.error({ err: error, key, storeId }, 'Failed to create idempotency key');
    throw error;
  }
}

/**
 * Mark idempotency key as completed with result
 * @param key - Idempotency key
 * @param storeId - Store ID
 * @param operation - Operation type
 * @param result - Operation result to cache
 * @param resourceId - ID of created resource (order_id, etc.)
 */
export async function completeIdempotencyKey(
  key: string,
  storeId: number,
  operation: string,
  result: Record<string, unknown>,
  resourceId: number | null = null
): Promise<void> {
  try {
    await query(
      `UPDATE idempotency_keys
       SET status = $1, response_data = $2, resource_id = $3, updated_at = NOW()
       WHERE idempotency_key = $4 AND store_id = $5 AND operation = $6`,
      [IdempotencyStatus.COMPLETED, JSON.stringify(result), resourceId, key, storeId, operation]
    );

    logger.debug({ key, storeId, operation, resourceId }, 'Idempotency key completed');
  } catch (error) {
    logger.error({ err: error, key, storeId }, 'Failed to complete idempotency key');
    throw error;
  }
}

/**
 * Mark idempotency key as failed with error
 * @param key - Idempotency key
 * @param storeId - Store ID
 * @param operation - Operation type
 * @param error - Error that occurred
 */
export async function failIdempotencyKey(
  key: string,
  storeId: number,
  operation: string,
  error: Error
): Promise<void> {
  try {
    await query(
      `UPDATE idempotency_keys
       SET status = $1, error_message = $2, updated_at = NOW()
       WHERE idempotency_key = $3 AND store_id = $4 AND operation = $5`,
      [IdempotencyStatus.FAILED, error.message, key, storeId, operation]
    );

    logger.debug({ key, storeId, operation, error: error.message }, 'Idempotency key marked as failed');
  } catch (err) {
    logger.error({ err, key, storeId }, 'Failed to mark idempotency key as failed');
    throw err;
  }
}

/**
 * Clean up old idempotency keys (called periodically)
 * Keys older than 24 hours are removed
 */
export async function cleanupIdempotencyKeys(): Promise<void> {
  try {
    const result = await query(
      `DELETE FROM idempotency_keys WHERE created_at < NOW() - INTERVAL '24 hours'`
    );

    if (result.rowCount && result.rowCount > 0) {
      logger.info({ deleted: result.rowCount }, 'Cleaned up old idempotency keys');
    }
  } catch (error) {
    logger.error({ err: error }, 'Failed to cleanup idempotency keys');
  }
}

/**
 * Idempotent operation wrapper
 * Wraps an async operation with idempotency checking
 *
 * @param key - Idempotency key
 * @param storeId - Store ID
 * @param operation - Operation name
 * @param fn - Async function to execute
 * @param metadata - Request metadata to store
 * @returns { result, deduplicated }
 */
export async function withIdempotency<T extends { id?: number; orderId?: number }>(
  key: string,
  storeId: number,
  operation: string,
  fn: () => Promise<T>,
  metadata: Record<string, unknown> = {}
): Promise<IdempotencyResult<T>> {
  // Check for existing key
  const existing = await checkIdempotencyKey(key, storeId, operation);

  if (existing) {
    switch (existing.status) {
      case IdempotencyStatus.COMPLETED:
        // Return cached result
        return {
          result: existing.response_data as T,
          resourceId: existing.resource_id,
          deduplicated: true,
        };

      case IdempotencyStatus.PROCESSING:
        // Request is in progress - reject to prevent race condition
        throw new Error('Request already in progress. Please wait and retry.');

      case IdempotencyStatus.FAILED:
        // Previous attempt failed - allow retry by continuing
        logger.info({ key, storeId, operation }, 'Retrying previously failed idempotent operation');
        break;
    }
  }

  // Create idempotency record
  await createIdempotencyKey(key, storeId, operation, IdempotencyStatus.PROCESSING, metadata);

  try {
    // Execute the operation
    const result = await fn();

    // Mark as completed
    await completeIdempotencyKey(
      key,
      storeId,
      operation,
      result as unknown as Record<string, unknown>,
      result?.id || result?.orderId || null
    );

    return {
      result,
      deduplicated: false,
    };
  } catch (error) {
    // Mark as failed
    await failIdempotencyKey(key, storeId, operation, error as Error);
    throw error;
  }
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
 * Middleware to extract and validate idempotency key from request
 */
export function idempotencyMiddleware(req: Request, res: Response, next: NextFunction): void | Response {
  const idempotencyKey = (req.headers['idempotency-key'] || req.headers['x-idempotency-key']) as string | undefined;

  if (idempotencyKey) {
    // Validate key format (should be UUID or similar)
    if (idempotencyKey.length < 16 || idempotencyKey.length > 64) {
      return res.status(400).json({
        error: 'Invalid idempotency key. Must be 16-64 characters.',
      });
    }

    req.idempotencyKey = idempotencyKey;
  }

  next();
}

// Start cleanup job (every hour)
setInterval(cleanupIdempotencyKeys, 60 * 60 * 1000);

export default {
  IdempotencyStatus,
  checkIdempotencyKey,
  createIdempotencyKey,
  completeIdempotencyKey,
  failIdempotencyKey,
  cleanupIdempotencyKeys,
  withIdempotency,
  idempotencyMiddleware,
};
