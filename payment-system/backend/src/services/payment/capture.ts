/**
 * Payment capture module.
 * Handles capturing authorized payments and recording ledger entries.
 */

import { withTransaction } from '../../db/connection.js';
import {
  logger,
  paymentTransactionsTotal,
  paymentProcessingDuration,
  auditPaymentCaptured,
  publishWebhook,
} from '../../shared/index.js';
import { LedgerService } from '../ledger.service.js';
import { MerchantService } from '../merchant.service.js';
import { validateForCapture } from './validation.js';
import type { Transaction, ClientInfo, PoolClient } from './types.js';

// Service instances
const ledgerService = new LedgerService();
const merchantService = new MerchantService();

/**
 * Captures funds from an authorized payment, making them available for settlement.
 *
 * @description Finalizes an authorized transaction by:
 * 1. Validating the transaction is in 'authorized' status
 * 2. Creating double-entry ledger entries for the captured amount and platform fee
 * 3. Updating the transaction status to 'captured'
 * 4. Publishing audit logs for PCI-DSS compliance
 * 5. Recording Prometheus metrics for monitoring
 * 6. Publishing a webhook event to notify the merchant
 *
 * IDEMPOTENCY: Capture operations are idempotent. Capturing an already-captured
 * transaction returns the existing state without error.
 *
 * @param transactionId - UUID of the authorized transaction to capture
 * @param merchantAccountId - UUID of the merchant's ledger account for settlements
 * @param transaction - Transaction object (must be pre-fetched by caller)
 * @param getTransactionFn - Function to fetch updated transaction after capture
 * @param clientInfo - Optional client info for audit logging (IP, user agent)
 * @returns Updated transaction with 'captured' status
 * @throws Error if transaction not found or not in 'authorized' status
 *
 * @example
 * const captured = await capturePayment(
 *   'txn_abc123',
 *   'acct_xyz789',
 *   transaction,
 *   (id) => paymentService.getTransaction(id),
 *   { ipAddress: '192.168.1.1' }
 * );
 */
export async function capturePayment(
  transactionId: string,
  merchantAccountId: string,
  transaction: Transaction,
  getTransactionFn: (id: string) => Promise<Transaction | null>,
  clientInfo?: ClientInfo
): Promise<Transaction> {
  const startTime = Date.now();

  // Validate transaction state
  const validation = validateForCapture(transaction);
  if (!validation.isValid) {
    throw new Error(validation.error);
  }

  // If already captured, return current state (idempotent)
  if (transaction.status === 'captured') {
    logger.info({ transactionId }, 'Transaction already captured, returning current state');
    return transaction;
  }

  // Create ledger entries within a transaction
  await withTransaction(async (client: PoolClient) => {
    // Record the double-entry bookkeeping
    await ledgerService.recordPaymentCapture(
      client,
      transactionId,
      merchantAccountId,
      transaction.amount,
      transaction.fee_amount,
      transaction.currency
    );

    // Update transaction status
    await client.query(
      `UPDATE transactions
       SET status = 'captured', captured_at = NOW(), updated_at = NOW(), version = version + 1
       WHERE id = $1`,
      [transactionId]
    );
  });

  // Audit log: payment captured
  await auditPaymentCaptured(
    transactionId,
    transaction.merchant_id,
    transaction.amount,
    clientInfo?.ipAddress,
    clientInfo?.userAgent
  );

  // Record metrics
  const duration = (Date.now() - startTime) / 1000;
  paymentProcessingDuration.labels('capture', 'captured').observe(duration);
  paymentTransactionsTotal.labels('captured', transaction.currency).inc();

  // Publish webhook to notify merchant of successful capture
  await publishMerchantWebhook(
    transaction.merchant_id,
    'payment.captured',
    {
      transaction_id: transactionId,
      amount: transaction.amount,
      currency: transaction.currency,
      fee_amount: transaction.fee_amount,
      net_amount: transaction.net_amount,
      captured_at: new Date().toISOString(),
    }
  );

  return (await getTransactionFn(transactionId))!;
}

/**
 * Publishes a webhook event to notify the merchant of a payment event.
 *
 * @description Sends a webhook notification to the merchant's configured webhook URL
 * via RabbitMQ for reliable delivery with retries. If the merchant has no webhook URL
 * configured, the function silently returns without error.
 *
 * @param merchantId - UUID of the merchant to notify
 * @param eventType - Type of webhook event (e.g., 'payment.captured', 'payment.refunded')
 * @param data - Event payload data to send in the webhook body
 * @returns Promise that resolves when webhook is queued (not delivered)
 *
 * @example
 * await publishMerchantWebhook('merchant_123', 'payment.captured', {
 *   transaction_id: 'txn_abc',
 *   amount: 10000,
 *   currency: 'USD'
 * });
 */
async function publishMerchantWebhook(
  merchantId: string,
  eventType: string,
  data: Record<string, unknown>
): Promise<void> {
  try {
    // Get merchant's webhook configuration
    const merchant = await merchantService.getMerchant(merchantId);

    if (!merchant?.webhook_url) {
      logger.debug(
        { merchantId, eventType },
        'Merchant has no webhook URL configured, skipping webhook'
      );
      return;
    }

    await publishWebhook(
      eventType,
      merchantId,
      data,
      merchant.webhook_url,
      merchant.webhook_secret
    );

    logger.debug(
      { merchantId, eventType },
      'Published webhook event to queue'
    );
  } catch (error) {
    // Log but don't fail the operation if webhook publish fails
    logger.error(
      { error, merchantId, eventType },
      'Failed to publish webhook to queue'
    );
  }
}

// Export for use by other modules
export { publishMerchantWebhook };
