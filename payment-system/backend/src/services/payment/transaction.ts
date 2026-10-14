/**
 * Transaction database operations module.
 * Handles low-level transaction creation and status updates.
 */

import { v4 as uuidv4 } from 'uuid';
import { query } from '../../db/connection.js';
import {
  logger,
  publishFraudCheck,
} from '../../shared/index.js';
import type { Transaction, CreatePaymentRequest } from './types.js';

/** Result of claiming a payment record for an idempotency key. */
export interface PaymentClaim {
  /** True if this request inserted the row and therefore owns processing. */
  claimed: boolean;
  /** The inserted row, or the existing row created by an earlier request. */
  transaction: Transaction;
}

/**
 * Inserts the payment in 'pending' status, using the row itself as the
 * idempotency record.
 *
 * `INSERT ... ON CONFLICT (merchant_id, idempotency_key) DO NOTHING` is the
 * claim: of N concurrent requests with the same key exactly one inserts and
 * goes on to call the processor; the others read the existing row. Because the
 * claim lives in the same database as the money movement, it cannot be lost
 * the way a cache entry can, and it never expires.
 */
export async function claimPaymentRecord(
  transactionId: string,
  merchantId: string,
  request: CreatePaymentRequest,
  requestHash: string | null,
  feeAmount: number,
  netAmount: number
): Promise<PaymentClaim> {
  const {
    amount,
    currency,
    payment_method,
    description,
    customer_email,
    idempotency_key,
    metadata = {},
    capture = true,
  } = request;

  const inserted = await query<Transaction>(
    `INSERT INTO transactions (
      id, idempotency_key, request_hash, merchant_id, amount, currency, status,
      payment_method, description, customer_email, fee_amount, net_amount, metadata, auto_capture
    ) VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7, $8, $9, $10, $11, $12, $13)
    ON CONFLICT (merchant_id, idempotency_key) DO NOTHING
    RETURNING *`,
    [
      transactionId,
      idempotency_key ?? null,
      requestHash,
      merchantId,
      amount,
      currency,
      JSON.stringify(payment_method),
      description,
      customer_email,
      feeAmount,
      netAmount,
      JSON.stringify(metadata),
      capture,
    ]
  );

  if (inserted[0]) {
    return { claimed: true, transaction: inserted[0] };
  }

  const existing = await query<Transaction>(
    'SELECT * FROM transactions WHERE merchant_id = $1 AND idempotency_key = $2',
    [merchantId, idempotency_key]
  );
  return { claimed: false, transaction: existing[0] };
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
