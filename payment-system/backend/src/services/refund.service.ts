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

export class RefundService {
  private ledgerService: LedgerService;

  constructor() {
    this.ledgerService = new LedgerService();
  }

  /**
   * Check idempotency for refund
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
   * Create a refund for a captured transaction
   */
  async createRefund(
    transactionId: string,
    merchantId: string,
    merchantAccountId: string,
    request: RefundRequest
  ): Promise<Refund> {
    const { amount, reason, idempotency_key } = request;

    // Check idempotency
    if (idempotency_key) {
      const existing = await this.checkIdempotency(idempotency_key);
      if (existing) {
        return existing;
      }
    }

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
    const refund = await withTransaction(async (client: PoolClient) => {
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

    // Update refund status and cache
    const completedRefund = await queryOne<Refund>(
      'SELECT * FROM refunds WHERE id = $1',
      [refundId]
    );

    if (idempotency_key && completedRefund) {
      await redis.setex(
        `refund_idempotency:${idempotency_key}`,
        86400,
        JSON.stringify(completedRefund)
      );
    }

    return completedRefund!;
  }

  /**
   * Get a single refund
   */
  async getRefund(id: string): Promise<Refund | null> {
    return queryOne<Refund>('SELECT * FROM refunds WHERE id = $1', [id]);
  }

  /**
   * Get all refunds for a transaction
   */
  async getRefundsForTransaction(transactionId: string): Promise<Refund[]> {
    return query<Refund>(
      'SELECT * FROM refunds WHERE original_tx_id = $1 ORDER BY created_at DESC',
      [transactionId]
    );
  }

  /**
   * List refunds for a merchant
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

export class ChargebackService {
  private ledgerService: LedgerService;
  private chargebackFee = 1500; // $15 chargeback fee

  constructor() {
    this.ledgerService = new LedgerService();
  }

  /**
   * Create a chargeback (typically initiated by card network)
   */
  async createChargeback(
    transactionId: string,
    merchantId: string,
    merchantAccountId: string,
    amount: number,
    reasonCode: string,
    reasonDescription: string
  ): Promise<Chargeback> {
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

    return chargeback;
  }

  /**
   * Update chargeback status (won/lost)
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
    } else {
      // Just update status to lost
      await query(
        `UPDATE chargebacks SET status = 'lost', updated_at = NOW() WHERE id = $1`,
        [chargebackId]
      );
    }

    return (await this.getChargeback(chargebackId))!;
  }

  /**
   * Get a single chargeback
   */
  async getChargeback(id: string): Promise<Chargeback | null> {
    return queryOne<Chargeback>('SELECT * FROM chargebacks WHERE id = $1', [id]);
  }

  /**
   * List chargebacks for a merchant
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
