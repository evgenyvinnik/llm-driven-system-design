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

/**
 * Core payment processing service.
 * Handles the full lifecycle of payments: creation, authorization, capture, and void.
 * Coordinates with fraud detection, ledger recording, and idempotency handling.
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
   * Create a new payment transaction
   */
  async createPayment(
    merchantId: string,
    merchantAccountId: string,
    request: CreatePaymentRequest
  ): Promise<CreatePaymentResponse> {
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

    // Check idempotency if key provided
    if (idempotency_key) {
      const existing = await this.checkIdempotency(idempotency_key);
      if (existing) {
        return {
          id: existing.id,
          status: existing.status,
          amount: existing.amount,
          currency: existing.currency,
          fee_amount: existing.fee_amount,
          net_amount: existing.net_amount,
          created_at: existing.created_at,
        };
      }
    }

    // Calculate fee
    const feeAmount = this.calculateFee(amount);
    const netAmount = amount - feeAmount;

    // Create transaction in pending status
    const transactionId = uuidv4();

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

    // Fraud check
    const riskScore = await this.fraudService.evaluate({
      amount,
      currency,
      payment_method,
      merchantId,
      customerEmail: customer_email,
    });

    if (riskScore > 90) {
      await this.updateTransactionStatus(transactionId, 'failed', { risk_score: riskScore });
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

    // Simulate processor authorization
    const authorized = await this.simulateProcessorAuth(amount, payment_method);

    if (!authorized) {
      await this.updateTransactionStatus(transactionId, 'failed', { risk_score: riskScore });
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
    await this.updateTransactionStatus(transactionId, 'authorized', {
      risk_score: riskScore,
      processor_ref: `proc_${uuidv4().slice(0, 8)}`,
    });

    // If capture is true, immediately capture
    if (capture) {
      await this.capturePayment(transactionId, merchantAccountId);

      // Cache the idempotency key
      if (idempotency_key) {
        const finalTx = await this.getTransaction(transactionId);
        if (finalTx) {
          await redis.setex(`idempotency:${idempotency_key}`, 86400, JSON.stringify(finalTx));
        }
      }

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
   * Capture an authorized payment
   */
  async capturePayment(transactionId: string, merchantAccountId: string): Promise<Transaction> {
    const transaction = await this.getTransaction(transactionId);

    if (!transaction) {
      throw new Error('Transaction not found');
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

    return (await this.getTransaction(transactionId))!;
  }

  /**
   * Void an authorized but not captured payment
   */
  async voidPayment(transactionId: string): Promise<Transaction> {
    const transaction = await this.getTransaction(transactionId);

    if (!transaction) {
      throw new Error('Transaction not found');
    }

    if (transaction.status !== 'authorized') {
      throw new Error(`Cannot void transaction in status: ${transaction.status}`);
    }

    await query(
      `UPDATE transactions SET status = 'voided', updated_at = NOW(), version = version + 1 WHERE id = $1`,
      [transactionId]
    );

    return (await this.getTransaction(transactionId))!;
  }

  /**
   * Get a single transaction
   */
  async getTransaction(id: string): Promise<Transaction | null> {
    return queryOne<Transaction>('SELECT * FROM transactions WHERE id = $1', [id]);
  }

  /**
   * List transactions for a merchant
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
   * Get ledger entries for a transaction
   */
  async getTransactionLedgerEntries(transactionId: string): Promise<LedgerEntry[]> {
    return query<LedgerEntry>(
      'SELECT * FROM ledger_entries WHERE transaction_id = $1 ORDER BY created_at',
      [transactionId]
    );
  }

  /**
   * Update transaction status with optional additional fields
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
   * Simulate processor authorization (in production, this would call real processor)
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
