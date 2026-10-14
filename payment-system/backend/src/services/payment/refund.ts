/**
 * Payment void module.
 * Handles voiding authorized payments before capture.
 * Note: Full refund processing is in the separate refund.service.ts file.
 */

import { pool, queryOne } from '../../db/connection.js';
import {
  logger,
  paymentTransactionsTotal,
  paymentProcessingDuration,
  auditPaymentVoided,
} from '../../shared/index.js';
import { transitionStatus } from './state-machine.js';
import { invalidState, notFound } from './errors.js';
import type { Transaction, ClientInfo } from './types.js';

/**
 * Cancels an authorized payment before capture, releasing the hold on customer funds.
 * No ledger entries are created since no money moved.
 *
 * The authorized -> voided transition is a compare-and-set, so a void racing a
 * capture cannot both succeed: whichever UPDATE runs second matches no row.
 *
 * IDEMPOTENCY: voiding an already-voided payment returns it with changed=false.
 */
export async function voidPayment(
  transactionId: string,
  clientInfo?: ClientInfo
): Promise<{ transaction: Transaction; changed: boolean }> {
  const startTime = Date.now();

  const voided = await transitionStatus(pool, transactionId, ['authorized'], 'voided');

  if (!voided) {
    const current = await queryOne<Transaction>('SELECT * FROM transactions WHERE id = $1', [transactionId]);
    if (!current) throw notFound('Payment');
    if (current.status === 'voided') {
      logger.info({ transactionId }, 'Payment already voided, returning current state');
      return { transaction: current, changed: false };
    }
    throw invalidState(current.status, 'void');
  }

  await auditPaymentVoided(voided.id, voided.merchant_id, clientInfo?.ipAddress, clientInfo?.userAgent);
  paymentProcessingDuration.labels('void', 'voided').observe((Date.now() - startTime) / 1000);
  paymentTransactionsTotal.labels('voided', voided.currency).inc();

  return { transaction: voided, changed: true };
}
