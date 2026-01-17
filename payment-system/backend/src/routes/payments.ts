import { Router } from 'express';
import type { Request, Response } from 'express';
import { PaymentService } from '../services/payment.service.js';
import { RefundService, ChargebackService } from '../services/refund.service.js';
import { LedgerService } from '../services/ledger.service.js';
import type { CreatePaymentRequest, RefundRequest, TransactionListParams } from '../types/index.js';
import { logger } from '../shared/index.js';

/**
 * Payment routes module.
 * Provides REST endpoints for the full payment lifecycle:
 * creation, retrieval, capture, void, and refund operations.
 *
 * All endpoints include:
 * - Idempotency support via Idempotency-Key header
 * - Audit logging for compliance
 * - Prometheus metrics collection
 */
const router = Router();
const paymentService = new PaymentService();
const refundService = new RefundService();
const chargebackService = new ChargebackService();
const ledgerService = new LedgerService();

/**
 * Extracts client information from request for audit logging.
 */
function getClientInfo(req: Request): { ipAddress?: string; userAgent?: string } {
  return {
    ipAddress: (req.headers['x-forwarded-for'] as string)?.split(',')[0] || req.ip,
    userAgent: req.headers['user-agent'],
  };
}

/**
 * Creates a new payment transaction.
 * Supports immediate capture or authorize-only mode.
 * Idempotency key prevents duplicate charges on network retries.
 * POST /api/v1/payments
 */
router.post('/', async (req: Request, res: Response) => {
  try {
    if (!req.merchant) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const paymentRequest: CreatePaymentRequest = {
      amount: req.body.amount,
      currency: req.body.currency || 'USD',
      payment_method: req.body.payment_method,
      description: req.body.description,
      customer_email: req.body.customer_email,
      idempotency_key: req.body.idempotency_key,
      metadata: req.body.metadata,
      capture: req.body.capture !== false, // Default to true
    };

    // Validate required fields
    if (!paymentRequest.amount || paymentRequest.amount <= 0) {
      res.status(400).json({ error: 'Amount must be a positive integer (in cents)' });
      return;
    }

    if (!paymentRequest.payment_method) {
      res.status(400).json({ error: 'Payment method is required' });
      return;
    }

    const result = await paymentService.createPayment(
      req.merchant.id,
      req.merchant.account_id,
      paymentRequest,
      getClientInfo(req)
    );

    res.status(201).json(result);
  } catch (error) {
    logger.error({ error, merchantId: req.merchant?.id }, 'Create payment error');
    res.status(500).json({
      error: 'Failed to create payment',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * Retrieves a specific payment by its unique identifier.
 * Only returns payments owned by the authenticated merchant.
 * GET /api/v1/payments/:id
 */
router.get('/:id', async (req: Request, res: Response) => {
  try {
    if (!req.merchant) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const transaction = await paymentService.getTransaction(req.params.id);

    if (!transaction) {
      res.status(404).json({ error: 'Payment not found' });
      return;
    }

    // Verify merchant owns this transaction
    if (transaction.merchant_id !== req.merchant.id) {
      res.status(403).json({ error: 'Access denied' });
      return;
    }

    res.json(transaction);
  } catch (error) {
    logger.error({ error, paymentId: req.params.id }, 'Get payment error');
    res.status(500).json({ error: 'Failed to get payment' });
  }
});

/**
 * Lists payments for the authenticated merchant with pagination and filtering.
 * Supports filtering by status and date range.
 * GET /api/v1/payments
 */
router.get('/', async (req: Request, res: Response) => {
  try {
    if (!req.merchant) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const params: TransactionListParams = {
      limit: Math.min(parseInt(req.query.limit as string) || 50, 100),
      offset: parseInt(req.query.offset as string) || 0,
      status: req.query.status as TransactionListParams['status'],
      from_date: req.query.from_date ? new Date(req.query.from_date as string) : undefined,
      to_date: req.query.to_date ? new Date(req.query.to_date as string) : undefined,
    };

    const result = await paymentService.listTransactions(req.merchant.id, params);

    res.json({
      data: result.transactions,
      total: result.total,
      limit: params.limit,
      offset: params.offset,
    });
  } catch (error) {
    logger.error({ error, merchantId: req.merchant?.id }, 'List payments error');
    res.status(500).json({ error: 'Failed to list payments' });
  }
});

/**
 * Captures funds from an authorized payment.
 * Moves payment from 'authorized' to 'captured' status and records ledger entries.
 *
 * IDEMPOTENCY: Capturing an already-captured payment returns success without changes.
 *
 * POST /api/v1/payments/:id/capture
 */
router.post('/:id/capture', async (req: Request, res: Response) => {
  try {
    if (!req.merchant) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const transaction = await paymentService.getTransaction(req.params.id);

    if (!transaction) {
      res.status(404).json({ error: 'Payment not found' });
      return;
    }

    if (transaction.merchant_id !== req.merchant.id) {
      res.status(403).json({ error: 'Access denied' });
      return;
    }

    const result = await paymentService.capturePayment(
      req.params.id,
      req.merchant.account_id,
      getClientInfo(req)
    );

    res.json(result);
  } catch (error) {
    logger.error({ error, paymentId: req.params.id }, 'Capture payment error');
    res.status(400).json({
      error: 'Failed to capture payment',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * Voids an authorized payment before capture.
 * Cancels the authorization and releases the hold on customer funds.
 *
 * IDEMPOTENCY: Voiding an already-voided payment returns success without changes.
 *
 * POST /api/v1/payments/:id/void
 */
router.post('/:id/void', async (req: Request, res: Response) => {
  try {
    if (!req.merchant) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const transaction = await paymentService.getTransaction(req.params.id);

    if (!transaction) {
      res.status(404).json({ error: 'Payment not found' });
      return;
    }

    if (transaction.merchant_id !== req.merchant.id) {
      res.status(403).json({ error: 'Access denied' });
      return;
    }

    const result = await paymentService.voidPayment(
      req.params.id,
      getClientInfo(req)
    );

    res.json(result);
  } catch (error) {
    logger.error({ error, paymentId: req.params.id }, 'Void payment error');
    res.status(400).json({
      error: 'Failed to void payment',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * Creates a full or partial refund for a captured payment.
 * Validates refund amount and creates reversing ledger entries.
 *
 * IDEMPOTENCY: If Idempotency-Key is provided, duplicate requests return
 * the cached refund response.
 *
 * POST /api/v1/payments/:id/refund
 */
router.post('/:id/refund', async (req: Request, res: Response) => {
  try {
    if (!req.merchant) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const transaction = await paymentService.getTransaction(req.params.id);

    if (!transaction) {
      res.status(404).json({ error: 'Payment not found' });
      return;
    }

    if (transaction.merchant_id !== req.merchant.id) {
      res.status(403).json({ error: 'Access denied' });
      return;
    }

    const refundRequest: RefundRequest = {
      amount: req.body.amount,
      reason: req.body.reason,
      idempotency_key: req.body.idempotency_key,
    };

    const result = await refundService.createRefund(
      req.params.id,
      req.merchant.id,
      req.merchant.account_id,
      refundRequest,
      getClientInfo(req)
    );

    res.status(201).json(result);
  } catch (error) {
    logger.error({ error, paymentId: req.params.id }, 'Create refund error');
    res.status(400).json({
      error: 'Failed to create refund',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * Retrieves all refunds associated with a specific payment.
 * Returns history of both full and partial refunds.
 * GET /api/v1/payments/:id/refunds
 */
router.get('/:id/refunds', async (req: Request, res: Response) => {
  try {
    if (!req.merchant) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const transaction = await paymentService.getTransaction(req.params.id);

    if (!transaction) {
      res.status(404).json({ error: 'Payment not found' });
      return;
    }

    if (transaction.merchant_id !== req.merchant.id) {
      res.status(403).json({ error: 'Access denied' });
      return;
    }

    const refunds = await refundService.getRefundsForTransaction(req.params.id);

    res.json({ data: refunds });
  } catch (error) {
    logger.error({ error, paymentId: req.params.id }, 'Get refunds error');
    res.status(500).json({ error: 'Failed to get refunds' });
  }
});

/**
 * Retrieves all ledger entries for a specific payment.
 * Shows the double-entry bookkeeping trail for auditing and reconciliation.
 * GET /api/v1/payments/:id/ledger
 */
router.get('/:id/ledger', async (req: Request, res: Response) => {
  try {
    if (!req.merchant) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const transaction = await paymentService.getTransaction(req.params.id);

    if (!transaction) {
      res.status(404).json({ error: 'Payment not found' });
      return;
    }

    if (transaction.merchant_id !== req.merchant.id) {
      res.status(403).json({ error: 'Access denied' });
      return;
    }

    const entries = await ledgerService.getEntriesForTransaction(req.params.id);

    res.json({ data: entries });
  } catch (error) {
    logger.error({ error, paymentId: req.params.id }, 'Get ledger entries error');
    res.status(500).json({ error: 'Failed to get ledger entries' });
  }
});

export default router;
