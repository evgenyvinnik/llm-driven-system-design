/**
 * Reconciliation of payments whose authorization outcome is unknown.
 *
 * A payment stays 'pending' when the processor call timed out after the
 * request was sent, or when the API process died mid-request. Marking it
 * failed would be wrong (the card may be authorized) and authorizing again
 * under a new reference would be worse (a double charge). Instead the
 * reconciler asks the processor what happened to OUR reference:
 *
 *   approved  -> apply the approval (authorize, and capture if requested)
 *   declined  -> fail the payment
 *   not found -> resubmit with the SAME reference; the processor deduplicates,
 *                so at most one authorization can ever exist
 *   no answer -> leave it pending for the next round
 *
 * Claiming work is a single UPDATE over `FOR UPDATE SKIP LOCKED`, which also
 * bumps updated_at as a lease: several reconcilers can run without picking the
 * same payment, and a live request still inside its first 30 seconds is left
 * alone. All outcomes are applied through guarded transitions, so a reconciler
 * racing the original request cannot apply a result twice.
 */

import { query } from '../../db/connection.js';
import { logger, paymentReconcileTotal } from '../../shared/index.js';
import { authorizeWithProcessor, lookupProcessorPayment } from './processor.js';
import { applyProcessorApproval, applyProcessorDecline } from './authorize.js';
import type { Transaction } from './types.js';

export interface ReconcileOptions {
  /** Only payments pending (and untouched) for at least this long. */
  olderThanSeconds?: number;
  /** Maximum payments per run. */
  limit?: number;
  /** After this many attempts a payment is left for manual review. */
  maxAttempts?: number;
}

export type ReconcileResult = 'authorized' | 'captured' | 'failed' | 'still_pending' | 'needs_review';

export interface ReconcileSummary {
  scanned: number;
  results: Record<ReconcileResult, number>;
}

const DEFAULTS: Required<ReconcileOptions> = { olderThanSeconds: 30, limit: 50, maxAttempts: 10 };

/** Claims a batch of stuck pending payments and bumps their attempt counter. */
async function claimStuckPayments(options: Required<ReconcileOptions>): Promise<Transaction[]> {
  return query<Transaction>(
    `UPDATE transactions
     SET reconcile_attempts = reconcile_attempts + 1, updated_at = NOW()
     WHERE id IN (
       SELECT id FROM transactions
       WHERE status = 'pending'
         AND updated_at < NOW() - make_interval(secs => $1)
         AND reconcile_attempts < $3
       ORDER BY updated_at
       LIMIT $2
       FOR UPDATE SKIP LOCKED)
     RETURNING *`,
    [options.olderThanSeconds, options.limit, options.maxAttempts]
  );
}

/** Resolves one pending payment against the processor. */
export async function reconcilePayment(
  payment: Transaction,
  maxAttempts = DEFAULTS.maxAttempts
): Promise<ReconcileResult> {
  let approvedRef: string | null = null;
  let declineReason: string | null = null;

  try {
    const lookup = await lookupProcessorPayment(payment.id);
    if (lookup.status === 'approved') {
      approvedRef = lookup.processorRef;
    } else if (lookup.status === 'declined') {
      declineReason = lookup.reason;
    } else {
      // The processor never recorded it. Resubmit under the same reference.
      const outcome = await authorizeWithProcessor(payment.id, Number(payment.amount), payment.payment_method);
      if (outcome.kind === 'approved') approvedRef = outcome.processorRef;
      else if (outcome.kind === 'declined') declineReason = outcome.reason;
    }
  } catch (error) {
    logger.warn({ error, transactionId: payment.id }, 'Processor lookup failed during reconciliation');
  }

  if (approvedRef) {
    const final = await applyProcessorApproval(payment.id, approvedRef);
    return final.status === 'captured' ? 'captured' : final.status === 'failed' ? 'failed' : 'authorized';
  }
  if (declineReason) {
    await applyProcessorDecline(payment.id, declineReason);
    return 'failed';
  }
  if (payment.reconcile_attempts >= maxAttempts) {
    logger.error(
      { transactionId: payment.id, attempts: payment.reconcile_attempts },
      'Payment still unresolved after maximum reconciliation attempts; needs manual review'
    );
    return 'needs_review';
  }
  return 'still_pending';
}

/** One reconciliation pass. Safe to run from several processes at once. */
export async function reconcilePendingPayments(options: ReconcileOptions = {}): Promise<ReconcileSummary> {
  const resolved = { ...DEFAULTS, ...options };
  const claimed = await claimStuckPayments(resolved);
  const summary: ReconcileSummary = {
    scanned: claimed.length,
    results: { authorized: 0, captured: 0, failed: 0, still_pending: 0, needs_review: 0 },
  };

  for (const payment of claimed) {
    const result = await reconcilePayment(payment, resolved.maxAttempts);
    summary.results[result]++;
    paymentReconcileTotal.labels(result).inc();
    logger.info({ transactionId: payment.id, result }, 'Reconciled pending payment');
  }
  return summary;
}
