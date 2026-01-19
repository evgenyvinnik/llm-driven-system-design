/**
 * Core payment processing service.
 * Handles the full lifecycle of payments: creation, authorization, capture, and void.
 *
 * CRITICAL FEATURES:
 * - Idempotency: Prevents double-charging on network retries
 * - Circuit Breaker: Protects against payment processor outages
 * - Audit Logging: Required for PCI-DSS compliance
 * - Metrics: Enables fraud detection and SLO monitoring
 * - Async Webhooks: Notifies merchants of payment events via RabbitMQ
 */

import { query, queryOne } from '../../db/connection.js';
import type {
  Transaction,
  TransactionStatus,
  CreatePaymentRequest,
  CreatePaymentResponse,
  TransactionListParams,
  LedgerEntry,
  ClientInfo,
} from './types.js';
import { calculateFee, checkIdempotency, getDefaultFeeConfig } from './validation.js';
import { createPayment as createPaymentInternal } from './authorize.js';
import { capturePayment as capturePaymentInternal } from './capture.js';
import { voidPayment as voidPaymentInternal } from './refund.js';

/**
 * PaymentService class that provides the public API for payment operations.
 *
 * @description Main entry point for all payment operations. Provides methods for:
 * - Creating new payments with fraud detection and optional auto-capture
 * - Capturing authorized payments
 * - Voiding authorized payments before capture
 * - Retrieving transaction details and history
 * - Accessing ledger entries for reconciliation
 *
 * CRITICAL FEATURES:
 * - Idempotency: Prevents double-charging on network retries
 * - Circuit Breaker: Protects against payment processor outages
 * - Audit Logging: Required for PCI-DSS compliance
 * - Metrics: Enables fraud detection and SLO monitoring
 * - Async Webhooks: Notifies merchants of payment events via RabbitMQ
 *
 * @example
 * const paymentService = new PaymentService();
 *
 * // Create a payment
 * const response = await paymentService.createPayment(
 *   'merchant_123',
 *   'acct_xyz',
 *   { amount: 10000, currency: 'USD', payment_method: {...}, idempotency_key: 'order-1' }
 * );
 *
 * // Capture an authorized payment
 * const captured = await paymentService.capturePayment('txn_abc', 'acct_xyz');
 */
export class PaymentService {
  private feeConfig = getDefaultFeeConfig();

  /**
   * Calculates the platform fee for a given transaction amount.
   *
   * @description Computes the platform fee using percentage + fixed fee model.
   *
   * @param amount - Transaction amount in cents
   * @returns Fee amount in cents
   *
   * @example
   * const fee = paymentService.calculateFee(10000); // Returns 320 for 2.9% + $0.30
   */
  calculateFee(amount: number): number {
    return calculateFee(amount, this.feeConfig).feeAmount;
  }

  /**
   * Checks if a payment was already processed using its idempotency key.
   *
   * @description Looks up existing transaction by idempotency key in cache and database.
   *
   * @param key - Idempotency key to check
   * @returns Existing transaction if found, null otherwise
   *
   * @deprecated Use withIdempotency from shared/idempotency.ts instead for new code.
   */
  async checkIdempotency(key: string): Promise<Transaction | null> {
    return checkIdempotency(key);
  }

  /**
   * Creates a new payment transaction with fraud detection and optional capture.
   *
   * @description Processes a new payment through fraud scoring, processor authorization,
   * and optional capture. Supports idempotency to prevent duplicate charges.
   *
   * @param merchantId - UUID of the merchant creating the payment
   * @param merchantAccountId - UUID of the merchant's ledger account
   * @param request - Payment request with amount, currency, payment method, etc.
   * @param clientInfo - Optional client info for audit logging (IP, user agent)
   * @returns Payment response with transaction ID, status, and amounts
   * @throws Error if payment processing fails unexpectedly
   *
   * @example
   * const response = await paymentService.createPayment(
   *   'merchant_123',
   *   'acct_xyz',
   *   {
   *     amount: 10000,
   *     currency: 'USD',
   *     payment_method: { type: 'card', last_four: '4242', card_brand: 'visa' },
   *     idempotency_key: 'order-12345',
   *     capture: true
   *   }
   * );
   */
  async createPayment(
    merchantId: string,
    merchantAccountId: string,
    request: CreatePaymentRequest,
    clientInfo?: ClientInfo
  ): Promise<CreatePaymentResponse> {
    return createPaymentInternal(
      merchantId, merchantAccountId, request, clientInfo,
      (txId, acctId, info) => this.capturePayment(txId, acctId, info)
    );
  }

  /**
   * Captures funds from an authorized payment.
   *
   * @description Finalizes an authorized transaction, moving funds to the merchant's
   * account. Creates double-entry ledger entries and publishes webhook notification.
   *
   * @param transactionId - UUID of the authorized transaction to capture
   * @param merchantAccountId - UUID of the merchant's ledger account
   * @param clientInfo - Optional client info for audit logging
   * @returns Updated transaction with 'captured' status
   * @throws Error if transaction not found or not in 'authorized' status
   *
   * @example
   * const captured = await paymentService.capturePayment('txn_abc123', 'acct_xyz789');
   */
  async capturePayment(
    transactionId: string,
    merchantAccountId: string,
    clientInfo?: ClientInfo
  ): Promise<Transaction> {
    const transaction = await this.getTransaction(transactionId);
    if (!transaction) throw new Error('Transaction not found');
    return capturePaymentInternal(
      transactionId, merchantAccountId, transaction,
      (id) => this.getTransaction(id), clientInfo
    );
  }

  /**
   * Cancels an authorized payment before capture.
   *
   * @description Voids an authorized transaction, releasing the hold on customer funds.
   * No ledger entries are created since no money was actually moved.
   *
   * @param transactionId - UUID of the authorized transaction to void
   * @param clientInfo - Optional client info for audit logging
   * @returns Updated transaction with 'voided' status
   * @throws Error if transaction not found or not in 'authorized' status
   *
   * @example
   * const voided = await paymentService.voidPayment('txn_abc123');
   */
  async voidPayment(transactionId: string, clientInfo?: ClientInfo): Promise<Transaction> {
    const transaction = await this.getTransaction(transactionId);
    if (!transaction) throw new Error('Transaction not found');
    return voidPaymentInternal(
      transactionId, transaction, (id) => this.getTransaction(id), clientInfo
    );
  }

  /**
   * Retrieves a single transaction by ID.
   *
   * @description Fetches a transaction record from the database by its UUID.
   *
   * @param id - UUID of the transaction to retrieve
   * @returns Transaction object if found, null otherwise
   *
   * @example
   * const transaction = await paymentService.getTransaction('txn_abc123');
   * if (transaction) {
   *   console.log(`Status: ${transaction.status}`);
   * }
   */
  async getTransaction(id: string): Promise<Transaction | null> {
    return queryOne<Transaction>('SELECT * FROM transactions WHERE id = $1', [id]);
  }

  /**
   * Retrieves a paginated list of transactions for a merchant.
   *
   * @description Fetches transactions belonging to a merchant with optional filtering
   * by status and date range. Results are ordered by creation date (newest first).
   *
   * @param merchantId - UUID of the merchant
   * @param params - Optional filtering and pagination parameters
   * @param params.limit - Maximum number of transactions to return (default: 50)
   * @param params.offset - Number of transactions to skip (default: 0)
   * @param params.status - Filter by transaction status
   * @param params.from_date - Filter transactions created on or after this date
   * @param params.to_date - Filter transactions created on or before this date
   * @returns Object containing transactions array and total count
   *
   * @example
   * const { transactions, total } = await paymentService.listTransactions(
   *   'merchant_123',
   *   { limit: 20, status: 'captured', from_date: '2024-01-01' }
   * );
   */
  async listTransactions(
    merchantId: string,
    params: TransactionListParams = {}
  ): Promise<{ transactions: Transaction[]; total: number }> {
    const { limit = 50, offset = 0, status, from_date, to_date } = params;
    const queryParams: unknown[] = [merchantId];
    let whereClause = 'WHERE merchant_id = $1';
    let paramIdx = 2;

    if (status) {
      whereClause += ` AND status = $${paramIdx++}`;
      queryParams.push(status);
    }
    if (from_date) {
      whereClause += ` AND created_at >= $${paramIdx++}`;
      queryParams.push(from_date);
    }
    if (to_date) {
      whereClause += ` AND created_at <= $${paramIdx++}`;
      queryParams.push(to_date);
    }

    const countResult = await queryOne<{ count: string }>(
      `SELECT COUNT(*) as count FROM transactions ${whereClause}`, queryParams
    );
    const transactions = await query<Transaction>(
      `SELECT * FROM transactions ${whereClause} ORDER BY created_at DESC LIMIT $${paramIdx} OFFSET $${paramIdx + 1}`,
      [...queryParams, limit, offset]
    );

    return { transactions, total: parseInt(countResult?.count || '0', 10) };
  }

  /**
   * Retrieves all ledger entries for a transaction.
   *
   * @description Fetches double-entry bookkeeping records associated with a transaction.
   * Useful for reconciliation and auditing captured payments, refunds, etc.
   *
   * @param transactionId - UUID of the transaction
   * @returns Array of ledger entries ordered by creation date
   *
   * @example
   * const entries = await paymentService.getTransactionLedgerEntries('txn_abc123');
   * entries.forEach(entry => {
   *   console.log(`${entry.account_id}: ${entry.amount} ${entry.entry_type}`);
   * });
   */
  async getTransactionLedgerEntries(transactionId: string): Promise<LedgerEntry[]> {
    return query<LedgerEntry>(
      'SELECT * FROM ledger_entries WHERE transaction_id = $1 ORDER BY created_at',
      [transactionId]
    );
  }
}

// Re-export types
export type {
  Transaction, TransactionStatus, CreatePaymentRequest, CreatePaymentResponse,
  TransactionListParams, LedgerEntry, ClientInfo,
};

// Export submodule functions
export { calculateFee, checkIdempotency } from './validation.js';
export { authorizeWithProcessor } from './processor.js';
