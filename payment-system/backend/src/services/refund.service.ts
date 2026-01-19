import { v4 as uuidv4 } from 'uuid';
import type { PoolClient } from 'pg';
import { query, queryOne, withTransaction } from '../db/connection.js';
import type {
  Refund,
  RefundStatus,
  Transaction,
  RefundRequest,
  Chargeback,
  ChargebackStatus,
} from '../types/index.js';
import { LedgerService } from './ledger.service.js';
import { redis } from '../db/connection.js';

// Import shared modules for observability and resilience
import {
  logger,
  withIdempotency,
  refundTransactionsTotal,
  chargebackEventsTotal,
  paymentProcessingDuration,
  auditRefundCreated,
  auditChargebackCreated,
} from '../shared/index.js';

/**
 * Service for processing refunds on captured payments.
 * Handles full and partial refunds with idempotency support.
 * Coordinates with the ledger service to reverse financial entries.
 *
 * CRITICAL FEATURES:
 * - Idempotency: Prevents duplicate refunds on network retries
 * - Audit Logging: Required for PCI-DSS compliance
 * - Metrics: Enables refund rate monitoring and fraud detection
 */
export class RefundService {
  private ledgerService: LedgerService;

  constructor() {
    this.ledgerService = new LedgerService();
  }

  /**
   * Checks if a refund request has already been processed.
   * Prevents duplicate refunds when clients retry requests.
   * @param key - Unique idempotency key for the refund request
   * @returns Existing refund if found, null otherwise
   * @deprecated Use withIdempotency from shared/idempotency.ts instead
   */
  async checkIdempotency(key: string): Promise<Refund | null> {
    const cached = await redis.get(`refund_idempotency:${key}`);
    if (cached) {
      return JSON.parse(cached) as Refund;
    }

    const existing = await queryOne<Refund>(
      'SELECT * FROM refunds WHERE idempotency_key = $1',
      [key]
    );

    if (existing) {
      await redis.setex(`refund_idempotency:${key}`, 86400, JSON.stringify(existing));
    }

    return existing;
  }

  /**
   * Creates a full or partial refund for a captured transaction.
   * Validates refund amount against remaining refundable balance.
   * Creates reversing ledger entries and updates transaction status.
   *
   * IDEMPOTENCY: If idempotency_key is provided, duplicate requests return
   * the cached response without reprocessing.
   *
   * @param transactionId - UUID of the original captured transaction
   * @param merchantId - UUID of the merchant for ownership verification
   * @param merchantAccountId - UUID of the merchant's ledger account
   * @param request - Refund details including optional amount and reason
   * @param clientInfo - Optional client info for audit logging
   * @returns Created refund record with completed status
   * @throws Error if transaction not refundable or amount exceeds limit
   */
  async createRefund(
    transactionId: string,
    merchantId: string,
    merchantAccountId: string,
    request: RefundRequest,
    clientInfo?: { ipAddress?: string; userAgent?: string }
  ): Promise<Refund> {
    const startTime = Date.now();
    const { idempotency_key } = request;

    // Use shared idempotency wrapper for refund operations
    const { result, fromCache } = await withIdempotency<Refund>(
      'refund',
      merchantId,
      idempotency_key,
      async () => {
        return this.processRefund(
          transactionId,
          merchantId,
          merchantAccountId,
          request,
          clientInfo
        );
      }
    );

    // Record metrics
    const duration = (Date.now() - startTime) / 1000;
    paymentProcessingDuration.labels('refund', result.status).observe(duration);

    if (fromCache) {
      logger.info(
        { merchantId, idempotencyKey: idempotency_key, refundId: result.id },
        'Returned cached refund response'
      );
    }

    return result;
  }

  /**
   * Internal refund processing logic.
   * Called by createRefund after idempotency check.
   */
  private async processRefund(
    transactionId: string,
    merchantId: string,
    merchantAccountId: string,
    request: RefundRequest,
    clientInfo?: { ipAddress?: string; userAgent?: string }
  ): Promise<Refund> {
    const { amount, reason, idempotency_key } = request;

    // Get original transaction
    const transaction = await queryOne<Transaction>(
      'SELECT * FROM transactions WHERE id = $1 AND merchant_id = $2',
      [transactionId, merchantId]
    );

    if (!transaction) {
      throw new Error('Transaction not found');
    }

    if (transaction.status !== 'captured' && transaction.status !== 'partially_refunded') {
      throw new Error(`Cannot refund transaction in status: ${transaction.status}`);
    }

    // Calculate refund amount (default to full refund)
    const refundAmount = amount ?? transaction.amount;

    // Check if refund amount is valid
    const existingRefunds = await this.getRefundsForTransaction(transactionId);
    const totalRefunded = existingRefunds.reduce(
      (sum, r) => sum + (r.status === 'completed' ? r.amount : 0),
      0
    );

    if (totalRefunded + refundAmount > transaction.amount) {
      throw new Error(
        `Refund amount ${refundAmount} exceeds remaining refundable amount ${transaction.amount - totalRefunded}`
      );
    }

    const refundId = uuidv4();
    const isFullRefund = totalRefunded + refundAmount === transaction.amount;

    // Process refund atomically
    const _refund = await withTransaction(async (client: PoolClient) => {
      // Create refund record
      const refundResult = await client.query<Refund>(
        `INSERT INTO refunds (id, idempotency_key, original_tx_id, merchant_id, amount, reason, status)
         VALUES ($1, $2, $3, $4, $5, $6, 'pending')
         RETURNING *`,
        [refundId, idempotency_key, transactionId, merchantId, refundAmount, reason]
      );

      // Record ledger entries
      await this.ledgerService.recordRefund(
        client,
        transactionId,
        refundId,
        merchantAccountId,
        refundAmount,
        transaction.amount,
        transaction.fee_amount,
        transaction.currency
      );

      // Update refund status
      await client.query(
        `UPDATE refunds SET status = 'completed', updated_at = NOW() WHERE id = $1`,
        [refundId]
      );

      // Update transaction status
      const newStatus = isFullRefund ? 'refunded' : 'partially_refunded';
      await client.query(
        `UPDATE transactions SET status = $1, updated_at = NOW(), version = version + 1 WHERE id = $2`,
        [newStatus, transactionId]
      );

      return refundResult.rows[0];
    });

    // Get completed refund
    const completedRefund = await queryOne<Refund>(
      'SELECT * FROM refunds WHERE id = $1',
      [refundId]
    );

    // Audit log: refund created
    await auditRefundCreated(
      refundId,
      transactionId,
      merchantId,
      refundAmount,
      isFullRefund,
      clientInfo?.ipAddress,
      clientInfo?.userAgent
    );

    // Record metrics
    refundTransactionsTotal.labels(isFullRefund ? 'full' : 'partial', 'completed').inc();

    logger.info(
      {
        refundId,
        transactionId,
        merchantId,
        amount: refundAmount,
        isFullRefund,
      },
      'Refund processed successfully'
    );

    return completedRefund!;
  }

  /**
   * Retrieves a single refund by its unique identifier.
   * @param id - UUID of the refund
   * @returns Refund if found, null otherwise
   */
  async getRefund(id: string): Promise<Refund | null> {
    return queryOne<Refund>('SELECT * FROM refunds WHERE id = $1', [id]);
  }

  /**
   * Retrieves all refunds associated with a specific transaction.
   * @param transactionId - UUID of the original transaction
   * @returns Array of refunds ordered by creation time (newest first)
   */
  async getRefundsForTransaction(transactionId: string): Promise<Refund[]> {
    return query<Refund>(
      'SELECT * FROM refunds WHERE original_tx_id = $1 ORDER BY created_at DESC',
      [transactionId]
    );
  }

  /**
   * Retrieves a paginated list of refunds for a merchant.
   * @param merchantId - UUID of the merchant
   * @param limit - Maximum number of refunds to return
   * @param offset - Number of refunds to skip for pagination
   * @returns Object containing refunds array and total count
   */
  async listRefunds(
    merchantId: string,
    limit = 50,
    offset = 0
  ): Promise<{ refunds: Refund[]; total: number }> {
    const countResult = await queryOne<{ count: string }>(
      'SELECT COUNT(*) as count FROM refunds WHERE merchant_id = $1',
      [merchantId]
    );

    const refunds = await query<Refund>(
      'SELECT * FROM refunds WHERE merchant_id = $1 ORDER BY created_at DESC LIMIT $2 OFFSET $3',
      [merchantId, limit, offset]
    );

    return {
      refunds,
      total: parseInt(countResult?.count || '0', 10),
    };
  }
}

/**
 * Service for handling chargebacks initiated by card issuers.
 * Chargebacks occur when customers dispute transactions with their bank.
 * Includes additional fees charged to merchants for chargeback processing.
 *
 * CRITICAL FEATURES:
 * - Audit Logging: Required for dispute resolution and compliance
 * - Metrics: Enables chargeback rate monitoring
 */
export class ChargebackService {
  private ledgerService: LedgerService;
  /** Fixed chargeback processing fee in cents ($15.00) */
  private chargebackFee = 1500;

  constructor() {
    this.ledgerService = new LedgerService();
  }

  /**
   * Creates a chargeback record when a card issuer notifies of a dispute.
   * Immediately debits the merchant's account for the disputed amount plus fee.
   * Sets a 7-day deadline for the merchant to submit evidence.
   * @param transactionId - UUID of the disputed transaction
   * @param merchantId - UUID of the merchant
   * @param merchantAccountId - UUID of the merchant's ledger account
   * @param amount - Disputed amount in cents
   * @param reasonCode - Card network reason code for the dispute
   * @param reasonDescription - Human-readable description of the dispute
   * @returns Created chargeback record
   */
  async createChargeback(
    transactionId: string,
    merchantId: string,
    merchantAccountId: string,
    amount: number,
    reasonCode: string,
    reasonDescription: string
  ): Promise<Chargeback> {
    const startTime = Date.now();

    const transaction = await queryOne<Transaction>(
      'SELECT * FROM transactions WHERE id = $1 AND merchant_id = $2',
      [transactionId, merchantId]
    );

    if (!transaction) {
      throw new Error('Transaction not found');
    }

    if (transaction.status !== 'captured' && transaction.status !== 'partially_refunded') {
      throw new Error(`Cannot create chargeback for transaction in status: ${transaction.status}`);
    }

    const chargebackId = uuidv4();
    const evidenceDueDate = new Date();
    evidenceDueDate.setDate(evidenceDueDate.getDate() + 7); // 7 days to respond

    const chargeback = await withTransaction(async (client: PoolClient) => {
      // Create chargeback record
      const result = await client.query<Chargeback>(
        `INSERT INTO chargebacks (
          id, transaction_id, merchant_id, amount, reason_code, reason_description,
          status, evidence_due_date
        ) VALUES ($1, $2, $3, $4, $5, $6, 'open', $7)
        RETURNING *`,
        [chargebackId, transactionId, merchantId, amount, reasonCode, reasonDescription, evidenceDueDate]
      );

      // Record ledger entries (debit merchant account)
      await this.ledgerService.recordChargeback(
        client,
        transactionId,
        chargebackId,
        merchantAccountId,
        amount,
        this.chargebackFee,
        transaction.currency
      );

      return result.rows[0];
    });

    // Audit log: chargeback created
    await auditChargebackCreated(
      chargebackId,
      transactionId,
      merchantId,
      amount,
      reasonCode
    );

    // Record metrics
    chargebackEventsTotal.labels('open').inc();
    const duration = (Date.now() - startTime) / 1000;
    paymentProcessingDuration.labels('chargeback', 'open').observe(duration);

    logger.warn(
      {
        chargebackId,
        transactionId,
        merchantId,
        amount,
        reasonCode,
        evidenceDueDate,
      },
      'Chargeback created'
    );

    return chargeback;
  }

  /**
   * Updates a chargeback's status based on the dispute outcome.
   * If the merchant wins, reverses the chargeback debit and refunds the fee.
   * @param chargebackId - UUID of the chargeback
   * @param merchantId - UUID of the merchant for ownership verification
   * @param merchantAccountId - UUID of the merchant's ledger account
   * @param status - New status ('won' or 'lost')
   * @returns Updated chargeback record
   * @throws Error if chargeback not found or already resolved
   */
  async updateChargebackStatus(
    chargebackId: string,
    merchantId: string,
    merchantAccountId: string,
    status: 'won' | 'lost'
  ): Promise<Chargeback> {
    const chargeback = await queryOne<Chargeback>(
      'SELECT * FROM chargebacks WHERE id = $1 AND merchant_id = $2',
      [chargebackId, merchantId]
    );

    if (!chargeback) {
      throw new Error('Chargeback not found');
    }

    if (chargeback.status !== 'open' && chargeback.status !== 'pending_response') {
      throw new Error(`Cannot update chargeback in status: ${chargeback.status}`);
    }

    // If won, we need to reverse the chargeback debit
    if (status === 'won') {
      await withTransaction(async (client: PoolClient) => {
        // Credit back the merchant account
        await client.query(
          `UPDATE accounts SET balance = balance + $1, updated_at = NOW() WHERE id = $2`,
          [chargeback.amount + this.chargebackFee, merchantAccountId]
        );

        // Update chargeback status
        await client.query(
          `UPDATE chargebacks SET status = 'won', updated_at = NOW() WHERE id = $1`,
          [chargebackId]
        );
      });

      // Record metrics
      chargebackEventsTotal.labels('won').inc();

      logger.info(
        { chargebackId, merchantId, amount: chargeback.amount },
        'Chargeback won - funds returned to merchant'
      );
    } else {
      // Just update status to lost
      await query(
        `UPDATE chargebacks SET status = 'lost', updated_at = NOW() WHERE id = $1`,
        [chargebackId]
      );

      // Record metrics
      chargebackEventsTotal.labels('lost').inc();

      logger.info(
        { chargebackId, merchantId, amount: chargeback.amount },
        'Chargeback lost - funds not returned'
      );
    }

    return (await this.getChargeback(chargebackId))!;
  }

  /**
   * Retrieves a single chargeback by its unique identifier.
   * @param id - UUID of the chargeback
   * @returns Chargeback if found, null otherwise
   */
  async getChargeback(id: string): Promise<Chargeback | null> {
    return queryOne<Chargeback>('SELECT * FROM chargebacks WHERE id = $1', [id]);
  }

  /**
   * Retrieves a paginated list of chargebacks for a merchant.
   * Optionally filters by chargeback status.
   * @param merchantId - UUID of the merchant
   * @param status - Optional status filter
   * @param limit - Maximum number of chargebacks to return
   * @param offset - Number of chargebacks to skip for pagination
   * @returns Object containing chargebacks array and total count
   */
  async listChargebacks(
    merchantId: string,
    status?: ChargebackStatus,
    limit = 50,
    offset = 0
  ): Promise<{ chargebacks: Chargeback[]; total: number }> {
    let whereClause = 'WHERE merchant_id = $1';
    const params: unknown[] = [merchantId];

    if (status) {
      whereClause += ' AND status = $2';
      params.push(status);
    }

    const countResult = await queryOne<{ count: string }>(
      `SELECT COUNT(*) as count FROM chargebacks ${whereClause}`,
      params
    );

    const chargebacks = await query<Chargeback>(
      `SELECT * FROM chargebacks ${whereClause} ORDER BY created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset]
    );

    return {
      chargebacks,
      total: parseInt(countResult?.count || '0', 10),
    };
  }
}
