import { v4 as uuidv4 } from 'uuid';
import type { PoolClient } from 'pg';
import { query, queryOne, withTransaction } from '../db/connection.js';
import type {
  Refund,
  RefundStatus as _RefundStatus,
  Transaction,
  RefundRequest,
  Chargeback,
  ChargebackStatus,
} from '../types/index.js';
import {
  LedgerService,
  buildChargebackJournal,
  buildChargebackReversalJournal,
  buildRefundJournal,
} from './ledger.service.js';
import { transitionStatus } from './payment/state-machine.js';
import { requestFingerprint } from './payment/validation.js';
import {
  PaymentError,
  idempotencyKeyReused,
  invalidState,
  notFound,
} from './payment/errors.js';

// Import shared modules for observability and resilience
import {
  logger,
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
   * Creates a full or partial refund for a captured payment.
   *
   * CONCURRENCY: the payment row is locked (SELECT ... FOR UPDATE) for the
   * whole refund, so refunds of one payment run one at a time and each sees
   * what the previous one committed. Without the lock two partial refunds can
   * both pass the "remaining amount" check and refund more than was captured.
   *
   * IDEMPOTENCY: (merchant_id, idempotency_key) is unique on refunds. A retry
   * takes the same lock, finds the refund the key already created and returns
   * it; the same key with a different body or payment is rejected with 422.
   *
   * The refund row, its ledger journal and the payment's status change commit
   * together. Amounts omitted from the request default to everything that is
   * still refundable.
   */
  async createRefund(
    transactionId: string,
    merchantId: string,
    request: RefundRequest,
    clientInfo?: { ipAddress?: string; userAgent?: string }
  ): Promise<{ refund: Refund; replayed: boolean }> {
    const startTime = Date.now();
    const { idempotency_key, reason } = request;
    const requestHash = idempotency_key
      ? requestFingerprint({ payment: transactionId, amount: request.amount ?? null, reason: reason ?? null })
      : null;

    const outcome = await withTransaction(async (client: PoolClient) => {
      const payment = (
        await client.query<Transaction>(
          'SELECT * FROM transactions WHERE id = $1 AND merchant_id = $2 FOR UPDATE',
          [transactionId, merchantId]
        )
      ).rows[0];
      if (!payment) throw notFound('Payment');

      if (idempotency_key) {
        const prior = (
          await client.query<Refund>(
            'SELECT * FROM refunds WHERE merchant_id = $1 AND idempotency_key = $2',
            [merchantId, idempotency_key]
          )
        ).rows[0];
        if (prior) {
          if ((prior.request_hash && prior.request_hash !== requestHash) || prior.original_tx_id !== transactionId) {
            throw idempotencyKeyReused();
          }
          return { refund: prior, replayed: true, isFullRefund: false };
        }
      }

      if (payment.status !== 'captured' && payment.status !== 'partially_refunded') {
        throw invalidState(payment.status, 'refund');
      }

      const totals = (
        await client.query<{ reserved: string; completed: string }>(
          `SELECT COALESCE(SUM(amount) FILTER (WHERE status IN ('pending', 'completed')), 0) AS reserved,
                  COALESCE(SUM(amount) FILTER (WHERE status = 'completed'), 0) AS completed
           FROM refunds WHERE original_tx_id = $1`,
          [transactionId]
        )
      ).rows[0];

      const paymentAmount = Number(payment.amount);
      const completed = Number(totals.completed);
      const refundable = paymentAmount - Number(totals.reserved);
      const refundAmount = request.amount ?? refundable;

      if (!Number.isSafeInteger(refundAmount) || refundAmount <= 0) {
        throw new PaymentError(422, 'invalid_amount', 'Refund amount must be a positive integer (in cents) and something must remain refundable', { refundable });
      }
      if (refundAmount > refundable) {
        throw new PaymentError(
          422,
          'amount_exceeds_refundable',
          `Refund amount ${refundAmount} exceeds remaining refundable amount ${refundable}`,
          { refundable }
        );
      }

      const merchant = await client.query<{ account_id: string }>(
        'SELECT account_id FROM merchants WHERE id = $1',
        [merchantId]
      );

      const refund = (
        await client.query<Refund>(
          `INSERT INTO refunds (id, idempotency_key, request_hash, original_tx_id, merchant_id, amount, reason, status)
           VALUES ($1, $2, $3, $4, $5, $6, $7, 'completed')
           RETURNING *`,
          [uuidv4(), idempotency_key ?? null, requestHash, transactionId, merchantId, refundAmount, reason]
        )
      ).rows[0];

      await this.ledgerService.postJournal(
        client,
        transactionId,
        payment.currency,
        buildRefundJournal(
          merchant.rows[0].account_id,
          refundAmount,
          completed,
          paymentAmount,
          Number(payment.fee_amount),
          transactionId
        )
      );

      const isFullRefund = completed + refundAmount === paymentAmount;
      await transitionStatus(
        client,
        transactionId,
        ['captured', 'partially_refunded'],
        isFullRefund ? 'refunded' : 'partially_refunded'
      );

      return { refund, replayed: false, isFullRefund };
    });

    const { refund, replayed, isFullRefund } = outcome;
    if (replayed) {
      logger.info({ merchantId, idempotencyKey: idempotency_key, refundId: refund.id }, 'Idempotent replay of refund');
      return { refund, replayed };
    }

    await auditRefundCreated(
      refund.id,
      transactionId,
      merchantId,
      Number(refund.amount),
      isFullRefund,
      clientInfo?.ipAddress,
      clientInfo?.userAgent
    );
    refundTransactionsTotal.labels(isFullRefund ? 'full' : 'partial', 'completed').inc();
    paymentProcessingDuration.labels('refund', refund.status).observe((Date.now() - startTime) / 1000);
    logger.info(
      { refundId: refund.id, transactionId, merchantId, amount: Number(refund.amount), isFullRefund },
      'Refund processed successfully'
    );

    return { refund, replayed };
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
      await this.ledgerService.postJournal(
        client,
        transactionId,
        transaction.currency,
        buildChargebackJournal(merchantAccountId, amount, this.chargebackFee, transactionId)
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
        // Guarded status change first, so a dispute is reversed at most once
        const updated = await client.query(
          `UPDATE chargebacks SET status = 'won', updated_at = NOW()
           WHERE id = $1 AND status IN ('open', 'pending_response')`,
          [chargebackId]
        );
        if (updated.rowCount === 0) {
          throw new PaymentError(409, 'invalid_state', 'Chargeback was already resolved');
        }

        // Return the disputed amount and the fee through a balanced reversing
        // journal (it used to be a bare balance update with no ledger entries)
        const payment = await client.query<{ currency: string }>(
          'SELECT currency FROM transactions WHERE id = $1',
          [chargeback.transaction_id]
        );
        await this.ledgerService.postJournal(
          client,
          chargeback.transaction_id,
          payment.rows[0].currency,
          buildChargebackReversalJournal(
            merchantAccountId,
            Number(chargeback.amount),
            this.chargebackFee,
            chargeback.transaction_id
          )
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
