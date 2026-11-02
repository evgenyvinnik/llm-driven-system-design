import { createHash } from 'crypto';
import type { PoolClient } from 'pg';
import { pool } from './db.js';
import { logger } from './logger.js';
import { idempotencyHits } from './metrics.js';
import { PaymentError } from './errors.js';

/** A client-supplied idempotency key plus the request it was sent with. */
export interface IdempotencyContext {
  userId: string;
  key: string;
  requestHash: string;
}

export type ClaimResult = { status: 'claimed' } | { status: 'replay'; response: unknown };

/**
 * Hashes the operation name and its parameters, so a key can only replay the
 * request it was first used for.
 */
export function hashRequest(operation: string, params: Record<string, unknown>): string {
  const canonical = JSON.stringify([operation, Object.keys(params).sort().map((k) => [k, params[k] ?? null])]);
  return createHash('sha256').update(canonical).digest('hex');
}

/**
 * Claims (user_id, key) inside the caller's transaction, before any money moves.
 *
 * - First use: the INSERT succeeds and holds the primary-key slot until the
 *   caller commits or rolls back. A concurrent request with the same key blocks
 *   on that slot instead of executing a second time.
 * - Already used (committed): returns the stored response for replay, or a 422
 *   if the key was used for a different request.
 * - An expired key is overwritten and reused.
 *
 * Keys are scoped per user, so one user's key never matches another user's.
 */
export async function claimIdempotencyKey(
  client: PoolClient,
  ctx: IdempotencyContext,
): Promise<ClaimResult> {
  const claimed = await client.query(
    `INSERT INTO idempotency_keys (user_id, key, request_hash)
     VALUES ($1, $2, $3)
     ON CONFLICT (user_id, key) DO UPDATE
       SET request_hash = EXCLUDED.request_hash, response = NULL,
           created_at = NOW(), expires_at = NOW() + INTERVAL '24 hours'
       WHERE idempotency_keys.expires_at <= NOW()
     RETURNING key`,
    [ctx.userId, ctx.key, ctx.requestHash],
  );
  if (claimed.rows.length > 0) {
    return { status: 'claimed' };
  }

  const existing = await client.query(
    `SELECT request_hash, response FROM idempotency_keys WHERE user_id = $1 AND key = $2`,
    [ctx.userId, ctx.key],
  );
  const row = existing.rows[0];
  if (!row || row.response === null) {
    // Only reachable if the row was cleaned up between the two statements.
    throw new PaymentError(409, 'IDEMPOTENCY_KEY_IN_PROGRESS', 'Request with this key is in progress, retry');
  }
  if (row.request_hash !== ctx.requestHash) {
    throw new PaymentError(
      422,
      'IDEMPOTENCY_KEY_REUSED',
      'Idempotency key was already used for a different request',
    );
  }

  idempotencyHits.inc();
  logger.info({ userId: ctx.userId, key: ctx.key }, 'Idempotency key hit');
  return { status: 'replay', response: row.response };
}

/** Records the response for a key claimed in this same transaction. */
export async function storeIdempotencyResponse(
  client: PoolClient,
  ctx: IdempotencyContext,
  response: unknown,
): Promise<void> {
  await client.query(
    `UPDATE idempotency_keys SET response = $3 WHERE user_id = $1 AND key = $2`,
    [ctx.userId, ctx.key, JSON.stringify(response)],
  );
}

/** Removes expired idempotency keys from the database and returns the count deleted. */
export async function cleanExpiredIdempotencyKeys(): Promise<number> {
  const result = await pool.query('DELETE FROM idempotency_keys WHERE expires_at < NOW()');
  const count = result.rowCount || 0;
  if (count > 0) {
    logger.info({ count }, 'Cleaned expired idempotency keys');
  }
  return count;
}
