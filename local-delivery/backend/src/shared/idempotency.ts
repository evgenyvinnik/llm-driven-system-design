/**
 * Idempotency service for preventing duplicate operations.
 * Uses database-backed idempotency keys for order placement and other critical operations.
 *
 * WHY idempotency:
 * - Prevents duplicate orders when clients retry on network timeout
 * - Prevents double charges if payment succeeds but response is lost
 * - Enables safe retries without side effects
 *
 * Implementation (one transaction, because the key and the order live in the
 * same PostgreSQL database):
 * 1. Client sends `Idempotency-Key` (a UUID per checkout attempt).
 * 2. BEGIN; INSERT the key ... ON CONFLICT DO NOTHING.
 *    - Inserted: run the operation on the same transaction, store its response
 *      on the key row, COMMIT. The key and the order commit together or not at
 *      all, so a crash mid-request leaves nothing behind and the retry runs.
 *    - Conflict: the key exists. A concurrent request holding it makes this
 *      INSERT wait (bounded by lock_timeout) until that request commits. Then:
 *      same user + same request fingerprint -> return the stored response;
 *      anything else -> 422, without revealing what the other request was.
 * 3. Keys expire after 24 hours via the hourly cleanup job.
 *
 * The previous version looked keys up without the user, so a second customer
 * presenting the same key received the first customer's order (address
 * included), and a crash between creating the order and completing the key
 * left the key "pending" for 24 hours.
 *
 * @module shared/idempotency
 */
import { createHash } from 'crypto';
import type { PoolClient } from 'pg';
import { execute, withTransaction } from '../utils/db.js';
import { HttpError } from './errors.js';
import { orderLogger } from './logger.js';

/**
 * Idempotency key record in the database.
 */
export interface IdempotencyKey {
  key: string;
  user_id: string;
  operation: string;
  request_hash: string | null;
  response: unknown;
  status: 'pending' | 'completed' | 'failed';
  created_at: Date;
  expires_at: Date;
}

/**
 * Result of an idempotent call.
 */
export interface IdempotencyResult<T> {
  /** True if the operation ran now; false if a stored response was replayed. */
  executed: boolean;
  /** The response from the operation or the stored one */
  response: T;
}

/** Idempotency key TTL in hours. */
const IDEMPOTENCY_KEY_TTL_HOURS = 24;

/** How long a duplicate waits for an in-flight request with the same key. */
const IDEMPOTENCY_LOCK_TIMEOUT = '5s';

/** Accepted key format: UUIDs and similar opaque tokens. */
export const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

/** A malformed, reused or busy idempotency key. */
export class IdempotencyError extends HttpError {
  constructor(message: string, statusCode: 400 | 409 | 422, code: string) {
    super(message, statusCode, code);
  }
}

/**
 * JSON with object keys sorted at every level, so logically equal requests
 * fingerprint the same regardless of key order.
 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null';
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
}

/**
 * SHA-256 fingerprint of an operation and its (validated) request.
 */
export function hashRequest(operation: string, request: unknown): string {
  return createHash('sha256').update(`${operation}:${stableStringify(request)}`).digest('hex');
}

/**
 * Runs `fn` in a transaction, at most once per (user, idempotency key).
 *
 * @param params.key - Client-supplied key; when absent `fn` simply runs in a transaction
 * @param params.userId - Caller; keys are never shared across users
 * @param params.operation - Operation name, e.g. 'create_order'
 * @param params.request - The validated request, fingerprinted to detect key reuse
 * @param fn - The operation; must do all its database work on the given client
 * @returns The fresh or replayed response
 * @throws IdempotencyError 400 (bad key), 409 (same key still in flight), 422 (key reused)
 */
export async function withIdempotentTransaction<T>(
  params: { key?: string; userId: string; operation: string; request: unknown },
  fn: (client: PoolClient) => Promise<T>
): Promise<IdempotencyResult<T>> {
  const { key, userId, operation, request } = params;

  if (!key) {
    orderLogger.debug({ operation }, 'No idempotency key provided, executing directly');
    return { executed: true, response: await withTransaction(fn) };
  }

  if (!IDEMPOTENCY_KEY_PATTERN.test(key)) {
    throw new IdempotencyError(
      'Idempotency-Key must be 8-64 characters of letters, digits, "-" or "_"',
      400,
      'IDEMPOTENCY_KEY_INVALID'
    );
  }

  const requestHash = hashRequest(operation, request);

  try {
    return await withTransaction(async (client) => {
      await client.query(`SET LOCAL lock_timeout = '${IDEMPOTENCY_LOCK_TIMEOUT}'`);

      // Expired keys may be reused; so may rows an older version of this code
      // committed as pending/failed before crashing.
      await client.query(
        `DELETE FROM idempotency_keys WHERE key = $1 AND (expires_at < NOW() OR status <> 'completed')`,
        [key]
      );

      const claimed = await client.query(
        `INSERT INTO idempotency_keys (key, user_id, operation, request_hash, status, expires_at)
         VALUES ($1, $2, $3, $4, 'pending', NOW() + make_interval(hours => $5))
         ON CONFLICT (key) DO NOTHING
         RETURNING key`,
        [key, userId, operation, requestHash, IDEMPOTENCY_KEY_TTL_HOURS]
      );

      if (claimed.rowCount === 0) {
        const existing = (
          await client.query<IdempotencyKey>(
            `SELECT user_id, operation, request_hash, status, response
             FROM idempotency_keys WHERE key = $1`,
            [key]
          )
        ).rows[0];

        if (!existing) {
          throw new IdempotencyError(
            'A request with this Idempotency-Key just finished; retry',
            409,
            'IDEMPOTENCY_IN_PROGRESS'
          );
        }
        const sameRequest =
          existing.user_id === userId &&
          existing.operation === operation &&
          (existing.request_hash === null || existing.request_hash === requestHash);
        if (!sameRequest || existing.status !== 'completed') {
          throw new IdempotencyError(
            'Idempotency-Key was already used for a different request',
            422,
            'IDEMPOTENCY_KEY_REUSED'
          );
        }

        orderLogger.info({ key, operation }, 'Returning stored response for idempotency key');
        return { executed: false, response: existing.response as T };
      }

      const response = await fn(client);
      await client.query(
        `UPDATE idempotency_keys SET status = 'completed', response = $2 WHERE key = $1`,
        [key, JSON.stringify(response)]
      );
      orderLogger.info({ key, operation }, 'Operation completed with idempotency key');
      return { executed: true, response };
    });
  } catch (error) {
    // lock_not_available: the first request with this key is still running.
    if ((error as { code?: string }).code === '55P03') {
      throw new IdempotencyError(
        'A request with this Idempotency-Key is still in progress; retry shortly',
        409,
        'IDEMPOTENCY_IN_PROGRESS'
      );
    }
    throw error;
  }
}

/**
 * Cleans up expired idempotency keys.
 * Should be called periodically (e.g., hourly via cron).
 *
 * @returns Number of keys deleted
 */
export async function cleanupExpiredIdempotencyKeys(): Promise<number> {
  const result = await execute(`DELETE FROM idempotency_keys WHERE expires_at < NOW()`);
  if (result > 0) {
    orderLogger.info({ count: result }, 'Cleaned up expired idempotency keys');
  }
  return result;
}

export default {
  withIdempotentTransaction,
  cleanupExpiredIdempotencyKeys,
};
