/**
 * Payment state machine.
 *
 *   pending ──▶ authorized ──▶ captured ──▶ partially_refunded ──▶ refunded
 *      │             │             └──────────────────────────────────▲
 *      ▼             ▼
 *    failed        voided
 *
 * Every status change goes through transitionStatus(), a compare-and-set:
 * `UPDATE ... WHERE id = $1 AND status = ANY(<allowed sources>)`. When two
 * requests race (capture vs capture, capture vs void, the live request vs the
 * reconciler), exactly one UPDATE matches; the loser gets null back and
 * re-reads the row instead of acting on a stale read.
 */

import type { Pool, PoolClient } from 'pg';
import type { Transaction, TransactionStatus } from './types.js';

export const ALLOWED_TRANSITIONS: Readonly<Record<TransactionStatus, readonly TransactionStatus[]>> = {
  pending: ['authorized', 'failed'],
  authorized: ['captured', 'voided'],
  captured: ['partially_refunded', 'refunded'],
  partially_refunded: ['partially_refunded', 'refunded'],
  refunded: [],
  voided: [],
  failed: [],
};

/** Columns a transition may set alongside the status (never user-supplied names). */
const UPDATABLE_FIELDS = new Set(['risk_score', 'processor_ref', 'captured_at']);

export function canTransition(from: TransactionStatus, to: TransactionStatus): boolean {
  return ALLOWED_TRANSITIONS[from]?.includes(to) ?? false;
}

/**
 * Atomically moves a payment from one of `from` to `to`.
 *
 * @returns the updated row, or null if the payment was not in any of `from`
 *          (someone else changed it first, or it never was).
 */
export async function transitionStatus(
  db: Pool | PoolClient,
  transactionId: string,
  from: readonly TransactionStatus[],
  to: TransactionStatus,
  fields: Record<string, unknown> = {}
): Promise<Transaction | null> {
  for (const source of from) {
    if (!canTransition(source, to)) {
      throw new Error(`Illegal payment transition: ${source} -> ${to}`);
    }
  }

  const sets = ['status = $2', 'updated_at = NOW()', 'version = version + 1'];
  const params: unknown[] = [transactionId, to, from];
  for (const [column, value] of Object.entries(fields)) {
    if (!UPDATABLE_FIELDS.has(column)) {
      throw new Error(`Column ${column} cannot be set by a status transition`);
    }
    params.push(value);
    sets.push(`${column} = $${params.length}`);
  }

  const result = await db.query<Transaction>(
    `UPDATE transactions SET ${sets.join(', ')}
     WHERE id = $1 AND status = ANY($3::varchar[])
     RETURNING *`,
    params
  );
  return result.rows[0] ?? null;
}
