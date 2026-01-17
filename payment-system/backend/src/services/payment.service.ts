import { v4 as uuidv4 } from 'uuid';
import type { PoolClient } from 'pg';
import {
  query,
  queryOne,
  withTransaction,
  SYSTEM_ACCOUNTS,
} from '../db/connection.js';
import type {
  Transaction,
  TransactionStatus,
  CreatePaymentRequest,
  CreatePaymentResponse,
  TransactionListParams,
  LedgerEntry,
} from '../types/index.js';
import { redis } from '../db/connection.js';
import { LedgerService } from './ledger.service.js';
import { FraudService } from './fraud.service.js';

// Import shared modules for observability and resilience
import {
  logger,
  withIdempotency,
  processorCircuitBreaker,
  paymentTransactionsTotal,
  paymentProcessingDuration,
  paymentAmountHistogram,
  fraudScoreHistogram,
  fraudDecisionsTotal,
  auditPaymentCreated,
  auditPaymentAuthorized,
  auditPaymentCaptured,
  auditPaymentVoided,
  auditPaymentFailed,
} from '../shared/index.js';

/**
 * Core payment processing service.
 * Handles the full lifecycle of payments: creation, authorization, capture, and void.
 * Coordinates with fraud detection, ledger recording, and idempotency handling.
 *
 * CRITICAL FEATURES:
 * - Idempotency: Prevents double-charging on network retries
 * - Circuit Breaker: Protects against payment processor outages
 * - Audit Logging: Required for PCI-DSS compliance
 * - Metrics: Enables fraud detection and SLO monitoring
 */
export class PaymentService {
  private ledgerService: LedgerService;
  private fraudService: FraudService;

  // Fee configuration (from env or defaults)
  /** Percentage fee charged on each transaction (e.g., 2.9 = 2.9%) */
  private feePercent = parseFloat(process.env.TRANSACTION_FEE_PERCENT || '2.9');
  /** Fixed fee in cents added to each transaction (e.g., 30 = $0.30) */
  private feeFixed = parseInt(process.env.TRANSACTION_FEE_FIXED || '30', 10);

  constructor() {
    this.ledgerService = new LedgerService();
    this.fraudService = new FraudService();
  }

  /**
   * Calculates the platform fee for a given transaction amount.
   * Uses percentage + fixed fee model (e.g., 2.9% + $0.30).
   * @param amount - Transaction amount in cents
   * @returns Fee amount in cents, rounded to nearest cent
   */
  calculateFee(amount: number): number {
    return Math.round(amount * (this.feePercent / 100) + this.feeFixed);
  }

  /**
   * Checks if a payment request has already been processed using its idempotency key.
   * Prevents duplicate charges when clients retry failed network requests.
   * Checks Redis cache first, then falls back to database lookup.
   * @param key - Unique idempotency key provided by the client
   * @returns Existing transaction if found, null if this is a new request
   * @deprecated Use withIdempotency from shared/idempotency.ts instead
   */
  async checkIdempotency(key: string): Promise<Transaction | null> {
    // First check Redis cache
    const cached = await redis.get(`idempotency:${key}`);
    if (cached) {
      return JSON.parse(cached) as Transaction;
    }

    // Fall back to database
    const existing = await queryOne<Transaction>(
      'SELECT * FROM transactions WHERE idempotency_key = $1',
      [key]
    );

    if (existing) {
      // Cache for future requests (24 hour TTL)
      await redis.setex(`idempotency:${key}`, 86400, JSON.stringify(existing));
    }

    return existing;
  }

  /**
   * Creates a new payment transaction with fraud detection and optional capture.
   * Implements the authorize-then-capture flow for card payments.
   *
   * IDEMPOTENCY: If idempotency_key is provided, duplicate requests return
   * the cached response without reprocessing.
   *
   * @param merchantId - UUID of the merchant initiating the payment
   * @param merchantAccountId - UUID of the merchant's ledger account
   * @param request - Payment details including amount, currency, and payment method
   * @param clientInfo - Optional client info for audit logging
   * @returns Response with transaction ID, status, and fee breakdown
   */
  async createPayment(
    merchantId: string,
    merchantAccountId: string,
    request: CreatePaymentRequest,
    clientInfo?: { ipAddress?: string; userAgent?: string }
  ): Promise<CreatePaymentResponse> {
    const startTime = Date.now();
    const {
      amount,
      currency,
      payment_method,
      description,
      customer_email,
      idempotency_key,
      metadata = {},
      capture = true, // Default to immediate capture
    } = request;

    // Use shared idempotency wrapper for all payment operations
    const { result, fromCache } = await withIdempotency<CreatePaymentResponse>(
      'payment',
      merchantId,
      idempotency_key,
      async () => {
        return this.processPayment(
          merchantId,
          merchantAccountId,
          request,
          clientInfo
        );
      }
    );

    // Record metrics
    const duration = (Date.now() - startTime) / 1000;
    paymentProcessingDuration.labels('create', result.status).observe(duration);

    if (fromCache) {
      logger.info(
        { merchantId, idempotencyKey: idempotency_key, transactionId: result.id },
        'Returned cached payment response'
      );
    }

    return result;
  }

  /**
   * Internal payment processing logic.
   * Called by createPayment after idempotency check.
   */
  private async processPayment(
    merchantId: string,
    merchantAccountId: string,
    request: CreatePaymentRequest,
    clientInfo?: { ipAddress?: string; userAgent?: string }
  ): Promise<CreatePaymentResponse> {
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

    // Calculate fee
    const feeAmount = this.calculateFee(amount);
    const netAmount = amount - feeAmount;

    // Create transaction in pending status
    const transactionId = uuidv4();

    // Record payment amount metric
    paymentAmountHistogram.labels(currency).observe(amount);

    const transaction = await withTransaction(async (client: PoolClient) => {
      // Insert transaction
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

    // Audit log: payment created
    await auditPaymentCreated(
      transactionId,
      merchantId,
      amount,
      currency,
      clientInfo?.ipAddress,
      clientInfo?.userAgent
    );

    // Fraud check
    const riskScore = await this.fraudService.evaluate({
      amount,
      currency,
      payment_method,
      merchantId,
      customerEmail: customer_email,
    });

    // Record fraud metrics
    fraudScoreHistogram.labels(riskScore > 90 ? 'decline' : 'approve').observe(riskScore);

    if (riskScore > 90) {
      fraudDecisionsTotal.labels('decline').inc();
      await this.updateTransactionStatus(transactionId, 'failed', { risk_score: riskScore });

      // Audit log: payment failed due to fraud
      await auditPaymentFailed(
        transactionId,
        merchantId,
        'High fraud risk score',
        clientInfo?.ipAddress,
        clientInfo?.userAgent
      );

      // Record failure metric
      paymentTransactionsTotal.labels('failed', currency).inc();

      return {
        id: transactionId,
        status: 'failed',
        amount,
        currency,
        fee_amount: feeAmount,
        net_amount: netAmount,
        created_at: transaction.created_at,
      };
    }

    fraudDecisionsTotal.labels('approve').inc();

    // Simulate processor authorization with circuit breaker protection
    const authorized = await this.authorizeWithProcessor(amount, payment_method);

    if (!authorized) {
      await this.updateTransactionStatus(transactionId, 'failed', { risk_score: riskScore });

      // Audit log: payment failed
      await auditPaymentFailed(
        transactionId,
        merchantId,
        'Processor declined',
        clientInfo?.ipAddress,
        clientInfo?.userAgent
      );

      // Record failure metric
      paymentTransactionsTotal.labels('failed', currency).inc();

      return {
        id: transactionId,
        status: 'failed',
        amount,
        currency,
        fee_amount: feeAmount,
        net_amount: netAmount,
        created_at: transaction.created_at,
      };
    }

    // Update to authorized
    const processorRef = `proc_${uuidv4().slice(0, 8)}`;
    await this.updateTransactionStatus(transactionId, 'authorized', {
      risk_score: riskScore,
      processor_ref: processorRef,
    });

    // Audit log: payment authorized
    await auditPaymentAuthorized(
      transactionId,
      merchantId,
      processorRef,
      clientInfo?.ipAddress,
      clientInfo?.userAgent
    );

    // Record authorization metric
    paymentTransactionsTotal.labels('authorized', currency).inc();

    // If capture is true, immediately capture
    if (capture) {
      await this.capturePayment(transactionId, merchantAccountId, clientInfo);

      return {
        id: transactionId,
        status: 'captured',
        amount,
        currency,
        fee_amount: feeAmount,
        net_amount: netAmount,
        created_at: transaction.created_at,
      };
    }

    return {
      id: transactionId,
      status: 'authorized',
      amount,
      currency,
      fee_amount: feeAmount,
      net_amount: netAmount,
      created_at: transaction.created_at,
    };
  }

  /**
   * Authorizes payment with external processor using circuit breaker.
   *
   * WHY CIRCUIT BREAKER: Payment processors can experience outages.
   * Without protection:
   * - All requests queue up waiting for timeouts
   * - Connection pools exhaust
   * - Cascading failures affect the entire system
   *
   * With circuit breaker:
   * - Fail fast after threshold (5 consecutive failures)
   * - System remains responsive for other operations
   * - Automatic recovery when processor comes back
   */
  private async authorizeWithProcessor(
    amount: number,
    paymentMethod: CreatePaymentRequest['payment_method']
  ): Promise<boolean> {
    try {
      return await processorCircuitBreaker.policy.execute(async () => {
        return this.simulateProcessorAuth(amount, paymentMethod);
      });
    } catch (error) {
      logger.error(
        { error, amount },
        'Payment processor authorization failed (circuit breaker may be open)'
      );
      return false;
    }
  }

  /**
   * Captures funds from an authorized payment, making them available for settlement.
   * Records double-entry ledger entries for the captured amount and platform fee.
   *
   * IDEMPOTENCY: Capture operations use transaction-level idempotency.
   * Capturing an already-captured transaction returns the existing state.
   *
   * @param transactionId - UUID of the authorized transaction to capture
   * @param merchantAccountId - UUID of the merchant's ledger account
   * @param clientInfo - Optional client info for audit logging
   * @returns Updated transaction with 'captured' status
   * @throws Error if transaction not found or not in 'authorized' status
   */
  async capturePayment(
    transactionId: string,
    merchantAccountId: string,
    clientInfo?: { ipAddress?: string; userAgent?: string }
  ): Promise<Transaction> {
    const startTime = Date.now();
    const transaction = await this.getTransaction(transactionId);

    if (!transaction) {
      throw new Error('Transaction not found');
    }

    // Idempotent: already captured, return current state
    if (transaction.status === 'captured') {
      logger.info({ transactionId }, 'Transaction already captured, returning current state');
      return transaction;
    }

    if (transaction.status !== 'authorized') {
      throw new Error(`Cannot capture transaction in status: ${transaction.status}`);
    }

    // Create ledger entries within a transaction
    await withTransaction(async (client: PoolClient) => {
      // Record the double-entry bookkeeping
      await this.ledgerService.recordPaymentCapture(
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

    return (await this.getTransaction(transactionId))!;
  }

  /**
   * Cancels an authorized payment before capture, releasing the hold on customer funds.
   * No ledger entries are created since no money was moved.
   *
   * IDEMPOTENCY: Voiding an already-voided transaction returns current state.
   *
   * @param transactionId - UUID of the authorized transaction to void
   * @param clientInfo - Optional client info for audit logging
   * @returns Updated transaction with 'voided' status
   * @throws Error if transaction not found or not in 'authorized' status
   */
  async voidPayment(
    transactionId: string,
    clientInfo?: { ipAddress?: string; userAgent?: string }
  ): Promise<Transaction> {
    const startTime = Date.now();
    const transaction = await this.getTransaction(transactionId);

    if (!transaction) {
      throw new Error('Transaction not found');
    }

    // Idempotent: already voided, return current state
    if (transaction.status === 'voided') {
      logger.info({ transactionId }, 'Transaction already voided, returning current state');
      return transaction;
    }

    if (transaction.status !== 'authorized') {
      throw new Error(`Cannot void transaction in status: ${transaction.status}`);
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

    return (await this.getTransaction(transactionId))!;
  }

  /**
   * Retrieves a single transaction by its unique identifier.
   * @param id - UUID of the transaction
   * @returns Transaction if found, null otherwise
   */
  async getTransaction(id: string): Promise<Transaction | null> {
    return queryOne<Transaction>('SELECT * FROM transactions WHERE id = $1', [id]);
  }

  /**
   * Retrieves a paginated list of transactions for a merchant.
   * Supports filtering by status and date range.
   * @param merchantId - UUID of the merchant
   * @param params - Pagination and filter options
   * @returns Object containing transactions array and total count
   */
  async listTransactions(
    merchantId: string,
    params: TransactionListParams = {}
  ): Promise<{ transactions: Transaction[]; total: number }> {
    const { limit = 50, offset = 0, status, from_date, to_date } = params;

    let whereClause = 'WHERE merchant_id = $1';
    const queryParams: unknown[] = [merchantId];
    let paramIndex = 2;

    if (status) {
      whereClause += ` AND status = $${paramIndex}`;
      queryParams.push(status);
      paramIndex++;
    }

    if (from_date) {
      whereClause += ` AND created_at >= $${paramIndex}`;
      queryParams.push(from_date);
      paramIndex++;
    }

    if (to_date) {
      whereClause += ` AND created_at <= $${paramIndex}`;
      queryParams.push(to_date);
      paramIndex++;
    }

    const countResult = await queryOne<{ count: string }>(
      `SELECT COUNT(*) as count FROM transactions ${whereClause}`,
      queryParams
    );

    const transactions = await query<Transaction>(
      `SELECT * FROM transactions ${whereClause} ORDER BY created_at DESC LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
      [...queryParams, limit, offset]
    );

    return {
      transactions,
      total: parseInt(countResult?.count || '0', 10),
    };
  }

  /**
   * Retrieves all ledger entries associated with a transaction.
   * Useful for auditing and reconciliation of the double-entry bookkeeping.
   * @param transactionId - UUID of the transaction
   * @returns Array of ledger entries ordered by creation time
   */
  async getTransactionLedgerEntries(transactionId: string): Promise<LedgerEntry[]> {
    return query<LedgerEntry>(
      'SELECT * FROM ledger_entries WHERE transaction_id = $1 ORDER BY created_at',
      [transactionId]
    );
  }

  /**
   * Updates a transaction's status and any additional fields atomically.
   * Increments the version number for optimistic locking.
   * @param id - UUID of the transaction to update
   * @param status - New status to set
   * @param additionalFields - Optional additional columns to update
   */
  private async updateTransactionStatus(
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
   * Simulates payment processor authorization.
   * In production, this would call real payment processors (Stripe, Adyen, etc.).
   * Returns false for test decline card numbers or high-risk amounts.
   * @param amount - Transaction amount in cents
   * @param paymentMethod - Payment method details for simulation logic
   * @returns True if authorization succeeds, false if declined
   */
  private async simulateProcessorAuth(
    amount: number,
    paymentMethod: CreatePaymentRequest['payment_method']
  ): Promise<boolean> {
    // Simulate some processing time
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Simulate decline for test card numbers or high amounts
    if (paymentMethod.last_four === '0000') {
      return false; // Test decline
    }

    if (amount > 1000000) {
      // Over $10,000 has higher decline rate
      return Math.random() > 0.3;
    }

    // 95% success rate for normal transactions
    return Math.random() > 0.05;
  }
}
