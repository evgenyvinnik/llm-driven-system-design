import { v4 as uuid } from 'uuid';
import { query, getClient } from '../utils/db.js';
import { redisClient } from '../utils/redis.js';
import logger, { auditLogger } from './logger.js';
import { idempotencyHits, idempotencyMisses } from './metrics.js';
import { Request, Response, NextFunction } from 'express';

/**
 * Idempotency handling for legal document operations.
 *
 * WHY IDEMPOTENCY IS CRITICAL FOR LEGAL DOCUMENT SIGNING:
 *
 * 1. LEGAL VALIDITY: Each signature must be unique and traceable. Duplicate
 *    signatures could invalidate a legal document or create compliance issues.
 *
 * 2. NETWORK RELIABILITY: Mobile/web clients may retry requests due to network
 *    issues. Without idempotency, a single signature could be recorded multiple
 *    times, corrupting the audit trail.
 *
 * 3. FINANCIAL IMPLICATIONS: Double-signing contracts could have serious legal
 *    and financial consequences (e.g., agreeing to terms twice, double billing).
 *
 * 4. AUDIT TRAIL INTEGRITY: The hash chain audit log must have exactly one
 *    entry per action. Duplicates break chain verification.
 *
 * 5. COMPLIANCE REQUIREMENTS: ESIGN Act, UETA, and eIDAS require accurate
 *    records of when and how each signature was captured.
 */

// Idempotency key TTL (24 hours - enough for client retries)
const IDEMPOTENCY_TTL_SECONDS = 86400;

export interface IdempotencyResult<T> {
  data: T;
  cached: boolean;
}

interface IdempotencyKeyRow {
  response: unknown;
}

/**
 * Check if an operation was already performed using idempotency key.
 * Uses Redis for fast lookups with PostgreSQL as persistent backup.
 *
 * @param idempotencyKey - Unique key for the operation
 * @returns Cached response if exists, null if new operation
 */
export async function checkIdempotency<T>(idempotencyKey: string | undefined): Promise<T | null> {
  if (!idempotencyKey) {
    return null;
  }

  const cacheKey = `idempotent:${idempotencyKey}`;

  try {
    // Check Redis first (fast path)
    const cached = await redisClient.get(cacheKey);
    if (cached) {
      logger.info({ idempotencyKey }, 'Idempotency hit (Redis cache)');
      idempotencyHits.inc({ operation: 'signature' });
      return JSON.parse(cached) as T;
    }

    // Check PostgreSQL (slow path, for durability)
    const result = await query<IdempotencyKeyRow>(
      `SELECT response FROM idempotency_keys
       WHERE key = $1 AND created_at > NOW() - INTERVAL '24 hours'`,
      [idempotencyKey]
    );

    if (result.rows.length > 0) {
      const response = result.rows[0].response;
      // Populate Redis cache for future requests
      await redisClient.setEx(cacheKey, IDEMPOTENCY_TTL_SECONDS, JSON.stringify(response));
      logger.info({ idempotencyKey }, 'Idempotency hit (PostgreSQL)');
      idempotencyHits.inc({ operation: 'signature' });
      return response as T;
    }

    idempotencyMisses.inc({ operation: 'signature' });
    return null;
  } catch (error) {
    // Log but don't fail - idempotency is a safety feature
    const err = error as Error;
    logger.error({ error: err.message, idempotencyKey }, 'Idempotency check failed');
    return null;
  }
}

/**
 * Store idempotency key with response for future duplicate detection.
 *
 * @param idempotencyKey - Unique key for the operation
 * @param response - Response to cache
 */
export async function storeIdempotency<T>(idempotencyKey: string | undefined, response: T): Promise<void> {
  if (!idempotencyKey) {
    return;
  }

  const cacheKey = `idempotent:${idempotencyKey}`;

  try {
    // Store in both Redis (fast) and PostgreSQL (durable)
    await Promise.all([
      redisClient.setEx(cacheKey, IDEMPOTENCY_TTL_SECONDS, JSON.stringify(response)),
      query(
        `INSERT INTO idempotency_keys (key, response, created_at)
         VALUES ($1, $2, NOW())
         ON CONFLICT (key) DO NOTHING`,
        [idempotencyKey, JSON.stringify(response)]
      ),
    ]);

    logger.debug({ idempotencyKey }, 'Idempotency key stored');
  } catch (error) {
    // Log but don't fail the main operation
    const err = error as Error;
    logger.error({ error: err.message, idempotencyKey }, 'Failed to store idempotency key');
  }
}

/**
 * Generate an idempotency key for signature operations.
 * Format: sig:{fieldId}:{recipientId}:{timestamp_bucket}
 *
 * Using 1-hour time buckets to allow legitimate re-signs after failures
 * while catching rapid duplicates.
 */
export function generateSignatureIdempotencyKey(fieldId: string, recipientId: string): string {
  const hourBucket = Math.floor(Date.now() / 3600000);
  return `sig:${fieldId}:${recipientId}:${hourBucket}`;
}

/**
 * Generate an idempotency key for envelope send operations.
 */
export function generateSendIdempotencyKey(envelopeId: string, userId: string): string {
  const hourBucket = Math.floor(Date.now() / 3600000);
  return `send:${envelopeId}:${userId}:${hourBucket}`;
}

/**
 * Generate an idempotency key for recipient completion.
 */
export function generateCompletionIdempotencyKey(recipientId: string): string {
  const hourBucket = Math.floor(Date.now() / 3600000);
  return `complete:${recipientId}:${hourBucket}`;
}

/**
 * Execute an operation with idempotency protection.
 * This is the main function to use for critical operations.
 *
 * @param idempotencyKey - Unique key for the operation
 * @param operation - Async function to execute
 * @param operationType - Type for logging (e.g., 'signature', 'send')
 * @returns Result with { data, cached: boolean }
 */
export async function executeWithIdempotency<T>(
  idempotencyKey: string,
  operation: () => Promise<T>,
  operationType: string = 'unknown'
): Promise<IdempotencyResult<T>> {
  // Check for existing result
  const existing = await checkIdempotency<T>(idempotencyKey);
  if (existing) {
    auditLogger.info({
      idempotencyKey,
      operationType,
      action: 'duplicate_detected',
    }, 'Duplicate operation detected and blocked');

    return { data: existing, cached: true };
  }

  // Execute the operation
  const result = await operation();

  // Store for future duplicate detection
  await storeIdempotency(idempotencyKey, result);

  auditLogger.info({
    idempotencyKey,
    operationType,
    action: 'operation_completed',
  }, 'Operation completed successfully');

  return { data: result, cached: false };
}

/**
 * Middleware to extract or generate idempotency key from request.
 * Clients should send X-Idempotency-Key header for POST/PUT requests.
 */
export function idempotencyMiddleware(req: Request, res: Response, next: NextFunction): void {
  // Only for mutating requests
  if (!['POST', 'PUT', 'PATCH'].includes(req.method)) {
    next();
    return;
  }

  // Get from header or generate based on request
  let idempotencyKey = req.headers['x-idempotency-key'] as string | undefined;

  if (!idempotencyKey) {
    // Generate a default key based on request body hash
    // This provides basic protection even without client cooperation
    const bodyHash = Buffer.from(JSON.stringify(req.body)).toString('base64').slice(0, 32);
    idempotencyKey = `auto:${req.path}:${bodyHash}`;
  }

  req.idempotencyKey = idempotencyKey;
  next();
}

export default {
  checkIdempotency,
  storeIdempotency,
  generateSignatureIdempotencyKey,
  generateSendIdempotencyKey,
  generateCompletionIdempotencyKey,
  executeWithIdempotency,
  idempotencyMiddleware,
};
