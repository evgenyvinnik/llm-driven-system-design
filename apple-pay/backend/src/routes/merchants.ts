/**
 * Merchant Routes with Idempotency and Audit Logging
 *
 * Express router for merchant-facing API endpoints.
 * Provides endpoints for merchants to process Apple Pay payments,
 * manage payment sessions, and handle refunds.
 *
 * CRITICAL FEATURES:
 * - Idempotency middleware on refund operations
 * - Audit logging for refund transactions
 * - Structured logging for observability
 */
import { Router, Request, Response } from 'express';
import { query } from '../db/index.js';
import { paymentService } from '../services/payment.js';
import { generateCryptogram } from '../utils/crypto.js';
import { z } from 'zod';

// Import shared infrastructure
import {
  createChildLogger,
  idempotencyMiddleware,
  auditLog,
} from '../shared/index.js';

const merchantLogger = createChildLogger({ module: 'MerchantRoutes' });

/**
 * Express router for merchant-facing API endpoints.
 * Provides endpoints for merchants to process Apple Pay payments,
 * manage payment sessions, and handle refunds.
 * Note: In production, these endpoints would require merchant API key authentication.
 */
const router = Router();

// Merchant API for processing Apple Pay payments
// In a real system, this would use merchant API keys for authentication

/** Zod schema for merchant payment processing validation */
const merchantPaymentSchema = z.object({
  token_dpan: z.string(),
  cryptogram: z.string(),
  amount: z.number().positive(),
  currency: z.string().length(3).default('USD'),
});

/** Zod schema for refund request validation */
const refundSchema = z.object({
  transaction_id: z.string().uuid(),
  amount: z.number().positive().optional(),
});

/**
 * GET /api/merchants/:merchantId
 * Retrieves information about a specific merchant.
 */
router.get('/:merchantId', async (req: Request, res: Response) => {
  try {
    const result = await query(
      `SELECT id, name, category_code, merchant_id, status FROM merchants WHERE id = $1`,
      [req.params.merchantId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Merchant not found' });
    }

    res.json({ merchant: result.rows[0] });
  } catch (error) {
    merchantLogger.error({ error: (error as Error).message }, 'Get merchant error');
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/merchants
 * Lists all active merchants (for demo purposes).
 */
router.get('/', async (_req: Request, res: Response) => {
  try {
    const result = await query(
      `SELECT id, name, category_code, merchant_id, status FROM merchants WHERE status = 'active'`,
      []
    );

    res.json({ merchants: result.rows });
  } catch (error) {
    merchantLogger.error({ error: (error as Error).message }, 'List merchants error');
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /api/merchants/:merchantId/sessions
 * Creates a payment session for in-app or web checkout.
 * Returns a session ID that can be used with the Apple Pay JS API.
 *
 * Idempotency: Required - prevents duplicate session creation
 */
router.post(
  '/:merchantId/sessions',
  idempotencyMiddleware({ required: true }),
  async (req: Request, res: Response) => {
    try {
      const { merchantId } = req.params;
      const { amount, currency = 'USD', items = [] } = req.body;

      if (!amount || amount <= 0) {
        return res.status(400).json({ error: 'Valid amount is required' });
      }

      const merchant = await query(
        `SELECT * FROM merchants WHERE id = $1 AND status = 'active'`,
        [merchantId]
      );

      if (merchant.rows.length === 0) {
        return res.status(404).json({ error: 'Merchant not found' });
      }

      // Create a payment session
      const sessionId = `PS_${Date.now()}_${Math.random().toString(36).substring(7)}`;
      const session = {
        id: sessionId,
        merchant_id: merchantId,
        merchant_name: merchant.rows[0].name,
        amount,
        currency,
        items,
        created_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + 30 * 60 * 1000).toISOString(), // 30 minutes
      };

      merchantLogger.info(
        { merchantId, sessionId, amount, currency },
        'Payment session created'
      );

      res.json({ session });
    } catch (error) {
      merchantLogger.error({ error: (error as Error).message }, 'Create session error');
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

/**
 * POST /api/merchants/:merchantId/process
 * Processes an Apple Pay payment with token and cryptogram.
 * Simulates the merchant-side integration with card networks.
 *
 * Idempotency: Required - prevents duplicate payment processing
 */
router.post(
  '/:merchantId/process',
  idempotencyMiddleware({ required: true }),
  async (req: Request, res: Response) => {
    try {
      const { merchantId } = req.params;
      const data = merchantPaymentSchema.parse(req.body);

      const merchant = await query(
        `SELECT * FROM merchants WHERE id = $1 AND status = 'active'`,
        [merchantId]
      );

      if (merchant.rows.length === 0) {
        return res.status(404).json({ error: 'Merchant not found' });
      }

      // Validate cryptogram (simplified)
      // In a real system, this would go through the card network
      const expectedCryptogram = generateCryptogram(
        data.token_dpan,
        data.amount,
        merchant.rows[0].merchant_id,
        Math.floor(Date.now() / 1000) * 1000 // Round to nearest second
      );

      // For demo, we accept payments regardless of cryptogram
      // In production, invalid cryptograms would be rejected

      const approved = data.amount < 10000; // Simple limit check
      const authCode = approved
        ? Math.random().toString(36).substring(2, 8).toUpperCase()
        : undefined;

      merchantLogger.info(
        {
          merchantId,
          amount: data.amount,
          currency: data.currency,
          approved,
        },
        'Merchant payment processed'
      );

      res.json({
        approved,
        auth_code: authCode,
        decline_reason: approved ? undefined : 'Amount exceeds limit',
        merchant_name: merchant.rows[0].name,
        amount: data.amount,
        currency: data.currency,
      });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: 'Invalid input', details: error.errors });
      }
      merchantLogger.error({ error: (error as Error).message }, 'Process payment error');
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

/**
 * POST /api/merchants/:merchantId/refund
 * Refunds a previously completed transaction.
 * Supports partial refunds when amount is specified.
 *
 * CRITICAL: This endpoint requires idempotency to prevent double-refunds.
 * The idempotency key should be provided by the merchant.
 */
router.post(
  '/:merchantId/refund',
  idempotencyMiddleware({ required: true }),
  async (req: Request, res: Response) => {
    try {
      const { merchantId } = req.params;
      const data = refundSchema.parse(req.body);

      merchantLogger.info(
        {
          merchantId,
          transactionId: data.transaction_id,
          amount: data.amount,
        },
        'Processing refund'
      );

      const result = await paymentService.refundTransaction(
        merchantId,
        data.transaction_id,
        data.amount
      );

      if (!result.success) {
        merchantLogger.warn(
          {
            merchantId,
            transactionId: data.transaction_id,
            error: result.error,
          },
          'Refund declined'
        );
        return res.status(400).json({ error: result.error });
      }

      // Audit log the refund
      await auditLog.refund(
        req,
        result.refundId!,
        data.transaction_id,
        'approved',
        {
          amount: data.amount || 0,
          currency: 'USD',
        }
      );

      merchantLogger.info(
        {
          merchantId,
          transactionId: data.transaction_id,
          refundId: result.refundId,
        },
        'Refund approved'
      );

      res.json({
        success: true,
        refund_id: result.refundId,
      });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: 'Invalid input', details: error.errors });
      }
      merchantLogger.error({ error: (error as Error).message }, 'Refund error');
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

/**
 * GET /api/merchants/:merchantId/transactions
 * Lists all transactions for a specific merchant.
 * Supports pagination via limit and offset query parameters.
 */
router.get('/:merchantId/transactions', async (req: Request, res: Response) => {
  try {
    const { merchantId } = req.params;
    const { limit = 50, offset = 0 } = req.query;

    const result = await query(
      `SELECT t.*, pc.last4, pc.network
       FROM transactions t
       JOIN provisioned_cards pc ON t.card_id = pc.id
       WHERE t.merchant_id = $1
       ORDER BY t.created_at DESC
       LIMIT $2 OFFSET $3`,
      [merchantId, parseInt(limit as string), parseInt(offset as string)]
    );

    const countResult = await query(
      `SELECT COUNT(*) FROM transactions WHERE merchant_id = $1`,
      [merchantId]
    );

    res.json({
      transactions: result.rows,
      total: parseInt(countResult.rows[0].count),
    });
  } catch (error) {
    merchantLogger.error({ error: (error as Error).message }, 'Get merchant transactions error');
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
