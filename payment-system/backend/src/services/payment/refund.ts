/**
 * Payment void module.
 * Handles voiding authorized payments before capture.
 * Note: Full refund processing is in the separate refund.service.ts file.
 */

import { query } from '../../db/connection.js';
import {
  logger,
  paymentTransactionsTotal,
  paymentProcessingDuration,
  auditPaymentVoided,
} from '../../shared/index.js';
import { validateForVoid } from './validation.js';
import type { Transaction, ClientInfo } from './types.js';

/**
 * Cancels an authorized payment before capture, releasing the hold on customer funds.
 *
 * @description Voids an authorized transaction, preventing it from being captured.
 * No ledger entries are created since no actual money was moved - only the hold
 * on the customer's funds is released.
 *
 * IDEMPOTENCY: Void operations are idempotent. Voiding an already-voided
 * transaction returns the existing state without error.
 *
 * @param transactionId - UUID of the authorized transaction to void
 * @param transaction - Transaction object (must be pre-fetched by caller)
 * @param getTransactionFn - Function to fetch updated transaction after void
 * @param clientInfo - Optional client info for audit logging (IP, user agent)
 * @returns Updated transaction with 'voided' status
 * @throws Error if transaction not found or not in 'authorized' status
 *
 * @example
 * const voided = await voidPayment(
 *   'txn_abc123',
 *   transaction,
 *   (id) => paymentService.getTransaction(id),
 *   { ipAddress: '192.168.1.1' }
 * );
 */
export async function voidPayment(
  transactionId: string,
  transaction: Transaction,
  getTransactionFn: (id: string) => Promise<Transaction | null>,
  clientInfo?: ClientInfo
): Promise<Transaction> {
  const startTime = Date.now();

  // Validate transaction state
  const validation = validateForVoid(transaction);
  if (!validation.isValid) {
    throw new Error(validation.error);
  }

  // If already voided, return current state (idempotent)
  if (transaction.status === 'voided') {
    logger.info({ transactionId }, 'Transaction already voided, returning current state');
    return transaction;
  }

  await query(
    `UPDATE transactions SET status = 'voided', updated_at = NOW(), version = version + 1 WHERE id = $1`,
    [transactionId]
  );

  // Audit log: payment voided
  await auditPaymentVoided(
    transactionId,
    transaction.merchant_id,
    clientInfo?.ipAddress,
    clientInfo?.userAgent
  );

  // Record metrics
  const duration = (Date.now() - startTime) / 1000;
  paymentProcessingDuration.labels('void', 'voided').observe(duration);
  paymentTransactionsTotal.labels('voided', transaction.currency).inc();

  return (await getTransactionFn(transactionId))!;
}
