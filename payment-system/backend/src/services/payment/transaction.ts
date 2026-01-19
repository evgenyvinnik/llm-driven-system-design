/**
 * Transaction database operations module.
 * Handles low-level transaction creation and status updates.
 */

import { v4 as uuidv4 } from 'uuid';
import { query, withTransaction } from '../../db/connection.js';
import {
  logger,
  publishFraudCheck,
} from '../../shared/index.js';
import type {
  Transaction,
  TransactionStatus,
  CreatePaymentRequest,
  PoolClient,
} from './types.js';

/**
 * Creates a new transaction record in pending status.
 *
 * @description Inserts a new transaction into the database with 'pending' status.
 * The transaction is created within a database transaction for atomicity.
 * Payment method and metadata are stored as JSONB columns.
 *
 * @param transactionId - Pre-generated UUID for the transaction
 * @param merchantId - UUID of the merchant creating the payment
 * @param request - Payment request containing amount, currency, payment method, etc.
 * @param feeAmount - Calculated platform fee in cents
 * @param netAmount - Net amount for merchant after fees in cents
 * @returns The newly created Transaction object
 *
 * @example
 * const transaction = await createTransactionRecord(
 *   uuidv4(),
 *   'merchant_123',
 *   { amount: 10000, currency: 'USD', payment_method: {...}, idempotency_key: 'key123' },
 *   320,
 *   9680
 * );
 */
export async function createTransactionRecord(
  transactionId: string,
  merchantId: string,
  request: CreatePaymentRequest,
  feeAmount: number,
  netAmount: number
): Promise<Transaction> {
  const {
    amount,
    currency,
    payment_method,
    description,
    customer_email,
    idempotency_key,
    metadata = {},
  } = request;

  const transaction = await withTransaction(async (client: PoolClient) => {
    const result = await client.query<Transaction>(
      `INSERT INTO transactions (
        id, idempotency_key, merchant_id, amount, currency, status,
        payment_method, description, customer_email, fee_amount, net_amount, metadata
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
      RETURNING *`,
      [
        transactionId,
        idempotency_key,
        merchantId,
        amount,
        currency,
        'pending',
        JSON.stringify(payment_method),
        description,
        customer_email,
        feeAmount,
        netAmount,
        JSON.stringify(metadata),
      ]
    );
    return result.rows[0];
  });

  return transaction;
}

/**
 * Updates a transaction's status and any additional fields atomically.
 *
 * @description Updates the transaction status and increments the version number
 * for optimistic locking. Additional fields can be updated in the same query
 * (e.g., risk_score, processor_ref). The updated_at timestamp is automatically set.
 *
 * @param id - UUID of the transaction to update
 * @param status - New status to set (pending, authorized, captured, failed, voided, refunded)
 * @param additionalFields - Optional key-value pairs for additional columns to update
 * @returns Promise that resolves when update is complete
 *
 * @example
 * // Update status only
 * await updateTransactionStatus('txn_abc123', 'authorized');
 *
 * @example
 * // Update status with additional fields
 * await updateTransactionStatus('txn_abc123', 'authorized', {
 *   risk_score: 25,
 *   processor_ref: 'proc_xyz789'
 * });
 */
export async function updateTransactionStatus(
  id: string,
  status: TransactionStatus,
  additionalFields: Record<string, unknown> = {}
): Promise<void> {
  const updates = ['status = $2', 'updated_at = NOW()', 'version = version + 1'];
  const params: unknown[] = [id, status];
  let paramIndex = 3;

  for (const [key, value] of Object.entries(additionalFields)) {
    updates.push(`${key} = $${paramIndex}`);
    params.push(value);
    paramIndex++;
  }

  await query(
    `UPDATE transactions SET ${updates.join(', ')} WHERE id = $1`,
    params
  );
}

/**
 * Publishes an async fraud check message to the fraud-scoring queue.
 *
 * @description Sends a message to RabbitMQ for asynchronous deep fraud analysis.
 * This is a fire-and-forget operation that does not block the payment flow.
 * Errors are logged but do not cause the payment to fail.
 *
 * @param transactionId - UUID of the transaction to check
 * @param merchantId - UUID of the merchant
 * @param amount - Transaction amount in cents
 * @param currency - Three-letter currency code (e.g., 'USD')
 * @param paymentMethod - Payment method details for fraud analysis
 * @param customerEmail - Optional customer email for pattern detection
 * @param ipAddress - Optional client IP for geolocation-based fraud detection
 * @returns void (fire-and-forget, no return value)
 *
 * @example
 * publishAsyncFraudCheck(
 *   'txn_abc123',
 *   'merchant_xyz',
 *   10000,
 *   'USD',
 *   { type: 'card', last_four: '4242', card_brand: 'visa' },
 *   'customer@example.com',
 *   '192.168.1.1'
 * );
 */
export function publishAsyncFraudCheck(
  transactionId: string,
  merchantId: string,
  amount: number,
  currency: string,
  paymentMethod: CreatePaymentRequest['payment_method'],
  customerEmail?: string,
  ipAddress?: string
): void {
  publishFraudCheck(transactionId, {
    merchantId,
    amount,
    currency,
    paymentMethod: {
      type: paymentMethod.type,
      last_four: paymentMethod.last_four,
      card_brand: paymentMethod.card_brand,
    },
    customerEmail,
    ipAddress,
  }).catch((error) => {
    logger.error(
      { error, transactionId, merchantId },
      'Failed to publish fraud check to queue'
    );
  });
}

/**
 * Generates a new transaction ID.
 *
 * @description Creates a new UUID v4 for use as a transaction identifier.
 * Transaction IDs are generated before insertion to allow idempotency
 * key association and early logging.
 *
 * @returns A new UUID v4 string
 *
 * @example
 * const transactionId = generateTransactionId();
 * // Returns: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890'
 */
export function generateTransactionId(): string {
  return uuidv4();
}
