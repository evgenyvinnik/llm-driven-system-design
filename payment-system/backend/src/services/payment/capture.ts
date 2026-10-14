/**
 * Payment capture module.
 * Handles capturing authorized payments and recording ledger entries.
 */

import { withTransaction, queryOne } from '../../db/connection.js';
import {
  logger,
  paymentTransactionsTotal,
  paymentProcessingDuration,
  auditPaymentCaptured,
  publishWebhook,
} from '../../shared/index.js';
import { LedgerService, buildCaptureJournal } from '../ledger.service.js';
import { MerchantService } from '../merchant.service.js';
import { transitionStatus } from './state-machine.js';
import { invalidState, notFound } from './errors.js';
import type { Transaction, ClientInfo, PoolClient } from './types.js';

// Service instances
const ledgerService = new LedgerService();
const merchantService = new MerchantService();

/** Statuses that mean "this payment was captured at some point". */
const CAPTURED_STATES = new Set(['captured', 'partially_refunded', 'refunded']);

/**
 * Captures inside an open database transaction: a guarded authorized -> captured
 * transition followed by the capture journal. Because both run in the same
 * transaction, the ledger is posted exactly once per capture: a second,
 * concurrent capture finds the row no longer 'authorized' and posts nothing.
 *
 * @returns the captured row, or null if the payment was not 'authorized'
 */
export async function captureInTransaction(
  client: PoolClient,
  transactionId: string
): Promise<Transaction | null> {
  const captured = await transitionStatus(client, transactionId, ['authorized'], 'captured', {
    captured_at: new Date(),
  });
  if (!captured) return null;

  const merchant = await client.query<{ account_id: string }>(
    'SELECT account_id FROM merchants WHERE id = $1',
    [captured.merchant_id]
  );
  await ledgerService.postJournal(
    client,
    transactionId,
    captured.currency,
    buildCaptureJournal(merchant.rows[0].account_id, Number(captured.amount), Number(captured.fee_amount))
  );
  return captured;
}

/**
 * Captures funds from an authorized payment.
 *
 * IDEMPOTENCY: capturing a payment that was already captured returns its
 * current state with changed=false. Capturing a payment in any other state
 * (pending, voided, failed) is a 409.
 */
export async function capturePayment(
  transactionId: string,
  clientInfo?: ClientInfo
): Promise<{ transaction: Transaction; changed: boolean }> {
  const startTime = Date.now();

  const captured = await withTransaction((client) => captureInTransaction(client, transactionId));

  if (!captured) {
    const current = await queryOne<Transaction>('SELECT * FROM transactions WHERE id = $1', [transactionId]);
    if (!current) throw notFound('Payment');
    if (CAPTURED_STATES.has(current.status)) {
      logger.info({ transactionId, status: current.status }, 'Payment already captured, returning current state');
      return { transaction: current, changed: false };
    }
    throw invalidState(current.status, 'capture');
  }

  await afterCapture(captured, clientInfo);
  paymentProcessingDuration.labels('capture', 'captured').observe((Date.now() - startTime) / 1000);
  return { transaction: captured, changed: true };
}

/** Side effects after a capture has committed: audit, metrics, webhook. */
export async function afterCapture(captured: Transaction, clientInfo?: ClientInfo): Promise<void> {
  await auditPaymentCaptured(
    captured.id,
    captured.merchant_id,
    Number(captured.amount),
    clientInfo?.ipAddress,
    clientInfo?.userAgent
  );
  paymentTransactionsTotal.labels('captured', captured.currency).inc();

  await publishMerchantWebhook(captured.merchant_id, 'payment.captured', {
    transaction_id: captured.id,
    amount: Number(captured.amount),
    currency: captured.currency,
    fee_amount: Number(captured.fee_amount),
    net_amount: Number(captured.net_amount),
    captured_at: new Date().toISOString(),
  });
}

/**
 * Publishes a webhook event to notify the merchant of a payment event.
 *
 * @description Sends a webhook notification to the merchant's configured webhook URL
 * via RabbitMQ for reliable delivery with retries. If the merchant has no webhook URL
 * configured, the function silently returns without error. This is a best-effort
 * publish after the payment committed; a crash in between loses the event
 * (a transactional outbox would close that gap).
 */
async function publishMerchantWebhook(
  merchantId: string,
  eventType: string,
  data: Record<string, unknown>
): Promise<void> {
  try {
    const merchant = await merchantService.getMerchant(merchantId);

    if (!merchant?.webhook_url) {
      logger.debug({ merchantId, eventType }, 'Merchant has no webhook URL configured, skipping webhook');
      return;
    }

    await publishWebhook(eventType, merchantId, data, merchant.webhook_url, merchant.webhook_secret);
    logger.debug({ merchantId, eventType }, 'Published webhook event to queue');
  } catch (error) {
    // Log but don't fail the operation if webhook publish fails
    logger.error({ error, merchantId, eventType }, 'Failed to publish webhook to queue');
  }
}

// Export for use by other modules
export { publishMerchantWebhook };
