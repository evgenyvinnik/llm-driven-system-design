import { Router, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { query, transaction } from '../db/pool.js';
import { authenticateApiKey, AuthenticatedRequest } from '../middleware/auth.js';
import { idempotencyMiddleware } from '../middleware/idempotency.js';
import { assessRisk, getRiskAssessment, RiskAssessmentResult } from '../services/fraud.js';
import { createChargeEntries, calculateFee } from '../services/ledger.js';
import { authorize, capture, AuthorizeParams, CaptureParams } from '../services/cardNetwork.js';
import { sendWebhook } from '../services/webhooks.js';

// Import shared modules for observability
import logger from '../shared/logger.js';
import { auditLogger } from '../shared/audit.js';
import {
  paymentAmountCents,
  activePaymentIntents,
  fraudBlockedTotal,
  recordFraudCheck,
} from '../shared/metrics.js';
import type { PoolClient } from 'pg';

const router = Router();

// Interfaces
interface PaymentIntentRow {
  id: string;
  merchant_id: string;
  customer_id: string | null;
  amount: number;
  currency: string;
  status: string;
  payment_method_id: string | null;
  capture_method: string;
  description: string | null;
  metadata: Record<string, unknown> | null;
  idempotency_key: string | null;
  auth_code: string | null;
  decline_code: string | null;
  error_message: string | null;
  created_at: Date;
}

interface PaymentMethodRow {
  id: string;
  card_token: string;
  card_last4: string;
  card_brand: string;
  card_exp_month: number;
  card_exp_year: number;
}

interface PaymentIntentResponse {
  id: string;
  object: 'payment_intent';
  amount: number;
  currency: string;
  status: string;
  customer: string | null;
  payment_method: string | null;
  capture_method: string;
  description: string | null;
  metadata: Record<string, unknown>;
  created: number;
  livemode: boolean;
  last_payment_error?: {
    decline_code: string;
    message: string | null;
  };
  risk_assessment?: {
    risk_score: number;
    risk_level: string;
    decision: string;
  };
  next_action?: {
    type: string;
    redirect_url: string;
  };
}

interface CreatePaymentIntentBody {
  amount?: number;
  currency?: string;
  customer?: string;
  payment_method?: string;
  capture_method?: string;
  description?: string;
  metadata?: Record<string, unknown>;
}

interface ConfirmPaymentIntentBody {
  payment_method?: string;
}

interface CapturePaymentIntentBody {
  amount_to_capture?: number;
}

interface CancelPaymentIntentBody {
  cancellation_reason?: string;
}

interface UpdatePaymentIntentBody {
  amount?: number;
  currency?: string;
  description?: string;
  metadata?: Record<string, unknown>;
}

interface DatabaseError extends Error {
  code?: string;
  constraint?: string;
}

interface CardNetworkError extends Error {
  name: string;
}

// All routes require authentication
router.use(authenticateApiKey);

/**
 * Create a payment intent
 * POST /v1/payment_intents
 */
router.post('/', idempotencyMiddleware, async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const startTime = process.hrtime();

  try {
    const {
      amount,
      currency = 'usd',
      customer,
      payment_method,
      capture_method = 'automatic',
      description,
      metadata = {},
    } = req.body as CreatePaymentIntentBody;

    // Validate required fields
    if (!amount || typeof amount !== 'number' || amount <= 0) {
      res.status(400).json({
        error: {
          type: 'invalid_request_error',
          message: 'Amount is required and must be a positive integer (in cents)',
          param: 'amount',
        },
      });
      return;
    }

    // Validate currency
    const validCurrencies = ['usd', 'eur', 'gbp', 'cad', 'aud'];
    if (!validCurrencies.includes(currency.toLowerCase())) {
      res.status(400).json({
        error: {
          type: 'invalid_request_error',
          message: `Invalid currency. Supported: ${validCurrencies.join(', ')}`,
          param: 'currency',
        },
      });
      return;
    }

    const idempotencyKey = (req.headers['idempotency-key'] as string) || null;
    const id = uuidv4();

    // Determine initial status
    let status = 'requires_payment_method';
    if (payment_method) {
      status = 'requires_confirmation';
    }

    // Create payment intent
    const result = await query<PaymentIntentRow>(`
      INSERT INTO payment_intents
        (id, merchant_id, customer_id, amount, currency, status, payment_method_id,
         capture_method, description, metadata, idempotency_key)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      RETURNING *
    `, [
      id,
      req.merchantId,
      customer || null,
      amount,
      currency.toLowerCase(),
      status,
      payment_method || null,
      capture_method,
      description || null,
      JSON.stringify(metadata),
      idempotencyKey,
    ]);

    const paymentIntent = formatPaymentIntent(result.rows[0]);

    // Record metrics
    paymentAmountCents.observe({ currency: currency.toLowerCase(), status: 'created' }, amount);
    activePaymentIntents.inc({ status });

    // Audit log: Payment intent created
    await auditLogger.logPaymentIntentCreated(result.rows[0], {
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'] as string,
      traceId: req.headers['x-trace-id'] as string,
      metadata: { idempotency_key: idempotencyKey },
    });

    // Log the event
    const [s, ns] = process.hrtime(startTime);
    const durationMs = (s * 1000 + ns / 1e6).toFixed(2);

    logger.info({
      event: 'payment_intent_created',
      intent_id: id,
      merchant_id: req.merchantId,
      amount,
      currency,
      status,
      duration_ms: parseFloat(durationMs),
    });

    res.status(201).json(paymentIntent);
  } catch (error) {
    const dbError = error as DatabaseError;
    logger.error({
      event: 'payment_intent_create_error',
      error_message: dbError.message,
      merchant_id: req.merchantId,
    });

    // Handle unique constraint violation for idempotency key
    if (dbError.code === '23505' && dbError.constraint?.includes('idempotency')) {
      res.status(409).json({
        error: {
          type: 'idempotency_error',
          message: 'An idempotent request with this key already exists',
        },
      });
      return;
    }

    res.status(500).json({
      error: {
        type: 'api_error',
        message: 'Failed to create payment intent',
      },
    });
  }
});

/**
 * Get a payment intent
 * GET /v1/payment_intents/:id
 */
router.get('/:id', async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const result = await query<PaymentIntentRow>(`
      SELECT * FROM payment_intents
      WHERE id = $1 AND merchant_id = $2
    `, [req.params.id, req.merchantId]);

    if (result.rows.length === 0) {
      res.status(404).json({
        error: {
          type: 'invalid_request_error',
          message: 'Payment intent not found',
        },
      });
      return;
    }

    const paymentIntent = formatPaymentIntent(result.rows[0]);

    // Include risk assessment if exists
    const riskAssessment = await getRiskAssessment(req.params.id);
    if (riskAssessment) {
      paymentIntent.risk_assessment = {
        risk_score: parseFloat(riskAssessment.risk_score),
        risk_level: riskAssessment.risk_level,
        decision: riskAssessment.decision,
      };
    }

    res.json(paymentIntent);
  } catch (error) {
    const err = error as Error;
    logger.error({
      event: 'payment_intent_get_error',
      intent_id: req.params.id,
      error_message: err.message,
    });
    res.status(500).json({
      error: {
        type: 'api_error',
        message: 'Failed to retrieve payment intent',
      },
    });
  }
});

/**
 * List payment intents
 * GET /v1/payment_intents
 */
router.get('/', async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const { limit = '10', offset = '0', status, customer } = req.query as {
      limit?: string;
      offset?: string;
      status?: string;
      customer?: string;
    };

    let queryText = `
      SELECT * FROM payment_intents
      WHERE merchant_id = $1
    `;
    const params: unknown[] = [req.merchantId];
    let paramIndex = 2;

    if (status) {
      queryText += ` AND status = $${paramIndex}`;
      params.push(status);
      paramIndex++;
    }

    if (customer) {
      queryText += ` AND customer_id = $${paramIndex}`;
      params.push(customer);
      paramIndex++;
    }

    queryText += ` ORDER BY created_at DESC LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
    params.push(parseInt(limit), parseInt(offset));

    const result = await query<PaymentIntentRow>(queryText, params);

    // Get total count
    let countQuery = `SELECT COUNT(*) FROM payment_intents WHERE merchant_id = $1`;
    const countParams: unknown[] = [req.merchantId];

    if (status) {
      countQuery += ` AND status = $2`;
      countParams.push(status);
    }

    const countResult = await query<{ count: string }>(countQuery, countParams);

    res.json({
      object: 'list',
      data: result.rows.map(formatPaymentIntent),
      has_more: parseInt(offset) + result.rows.length < parseInt(countResult.rows[0].count),
      total_count: parseInt(countResult.rows[0].count),
    });
  } catch (error) {
    const err = error as Error;
    logger.error({
      event: 'payment_intents_list_error',
      error_message: err.message,
    });
    res.status(500).json({
      error: {
        type: 'api_error',
        message: 'Failed to list payment intents',
      },
    });
  }
});

/**
 * Confirm a payment intent
 * POST /v1/payment_intents/:id/confirm
 */
router.post('/:id/confirm', idempotencyMiddleware, async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const startTime = process.hrtime();

  try {
    const { payment_method } = req.body as ConfirmPaymentIntentBody;

    // Get payment intent
    const intentResult = await query<PaymentIntentRow>(`
      SELECT * FROM payment_intents
      WHERE id = $1 AND merchant_id = $2
    `, [req.params.id, req.merchantId]);

    if (intentResult.rows.length === 0) {
      res.status(404).json({
        error: {
          type: 'invalid_request_error',
          message: 'Payment intent not found',
        },
      });
      return;
    }

    const intent = intentResult.rows[0];
    const previousStatus = intent.status;

    // Validate state
    if (!['requires_payment_method', 'requires_confirmation'].includes(intent.status)) {
      res.status(400).json({
        error: {
          type: 'invalid_request_error',
          message: `Cannot confirm payment intent in status: ${intent.status}`,
        },
      });
      return;
    }

    // Get payment method
    const paymentMethodId = payment_method || intent.payment_method_id;

    if (!paymentMethodId) {
      res.status(400).json({
        error: {
          type: 'invalid_request_error',
          message: 'Payment method is required',
          param: 'payment_method',
        },
      });
      return;
    }

    const pmResult = await query<PaymentMethodRow>(`
      SELECT * FROM payment_methods
      WHERE id = $1 AND merchant_id = $2
    `, [paymentMethodId, req.merchantId]);

    if (pmResult.rows.length === 0) {
      res.status(400).json({
        error: {
          type: 'invalid_request_error',
          message: 'Payment method not found',
          param: 'payment_method',
        },
      });
      return;
    }

    const paymentMethod = pmResult.rows[0];

    // Assess fraud risk
    const riskResult = await assessRisk({
      paymentIntent: intent,
      paymentMethod,
      merchantId: req.merchantId!,
      ipAddress: req.ip,
    });

    // Record fraud metrics
    recordFraudCheck(riskResult.riskScore, riskResult.decision);

    // Audit log: Fraud check
    await auditLogger.logFraudCheck(
      intent.id,
      riskResult.riskScore,
      riskResult.decision,
      riskResult.signals.map(s => s.rule),
      {
        ipAddress: req.ip,
        traceId: req.headers['x-trace-id'] as string,
      }
    );

    // Block high-risk payments
    if (riskResult.decision === 'block') {
      await query(`
        UPDATE payment_intents
        SET status = 'failed', decline_code = 'fraudulent', error_message = $2
        WHERE id = $1
      `, [intent.id, 'Transaction blocked due to high fraud risk']);

      // Update metrics
      activePaymentIntents.dec({ status: previousStatus });
      activePaymentIntents.inc({ status: 'failed' });
      fraudBlockedTotal.inc({ rule: 'aggregate', risk_level: 'high' });

      // Audit log: Payment blocked
      await auditLogger.logPaymentIntentFailed(intent, 'fraudulent', {
        ipAddress: req.ip,
        traceId: req.headers['x-trace-id'] as string,
        metadata: { fraud_score: riskResult.riskScore },
      });

      logger.warn({
        event: 'payment_blocked_fraud',
        intent_id: intent.id,
        risk_score: riskResult.riskScore,
      });

      res.status(402).json({
        error: {
          type: 'card_error',
          code: 'fraudulent',
          message: 'Transaction blocked due to suspected fraud',
          decline_code: 'fraudulent',
        },
      });
      return;
    }

    // Require 3DS for review decisions
    if (riskResult.decision === 'review') {
      await query(`
        UPDATE payment_intents
        SET status = 'requires_action', payment_method_id = $2
        WHERE id = $1
      `, [intent.id, paymentMethodId]);

      activePaymentIntents.dec({ status: previousStatus });
      activePaymentIntents.inc({ status: 'requires_action' });

      const updatedIntent = await query<PaymentIntentRow>(`SELECT * FROM payment_intents WHERE id = $1`, [intent.id]);
      const formatted = formatPaymentIntent(updatedIntent.rows[0]);
      formatted.next_action = {
        type: 'redirect_to_3ds',
        redirect_url: `http://localhost:3001/v1/payment_intents/${intent.id}/3ds`,
      };

      logger.info({
        event: 'payment_requires_3ds',
        intent_id: intent.id,
        risk_score: riskResult.riskScore,
      });

      res.json(formatted);
      return;
    }

    // Authorize with card network (protected by circuit breaker)
    const authParams: AuthorizeParams = {
      amount: intent.amount,
      currency: intent.currency,
      cardToken: paymentMethod.card_token,
      merchantId: req.merchantId!,
    };
    const authResult = await authorize(authParams);

    if (!authResult.approved) {
      await query(`
        UPDATE payment_intents
        SET status = 'failed', decline_code = $2, payment_method_id = $3
        WHERE id = $1
      `, [intent.id, authResult.declineCode, paymentMethodId]);

      // Update metrics
      activePaymentIntents.dec({ status: previousStatus });
      activePaymentIntents.inc({ status: 'failed' });

      // Audit log: Payment failed
      await auditLogger.logPaymentIntentFailed(intent, authResult.declineCode || 'card_declined', {
        ipAddress: req.ip,
        traceId: req.headers['x-trace-id'] as string,
      });

      // Send webhook
      await sendWebhook(req.merchantId!, 'payment_intent.payment_failed', {
        id: intent.id,
        decline_code: authResult.declineCode,
      });

      logger.info({
        event: 'payment_declined',
        intent_id: intent.id,
        decline_code: authResult.declineCode,
      });

      res.status(402).json({
        error: {
          type: 'card_error',
          code: authResult.declineCode,
          message: getDeclineMessage(authResult.declineCode || 'card_declined'),
          decline_code: authResult.declineCode,
        },
      });
      return;
    }

    // Process successful authorization
    if (intent.capture_method === 'automatic') {
      // Automatic capture - create charge and ledger entries
      const result = await transaction(async (client: PoolClient) => {
        // Update intent to succeeded
        await client.query(`
          UPDATE payment_intents
          SET status = 'succeeded', auth_code = $2, payment_method_id = $3
          WHERE id = $1
        `, [intent.id, authResult.authCode, paymentMethodId]);

        // Create charge
        const fee = calculateFee(intent.amount);
        const chargeId = uuidv4();

        await client.query(`
          INSERT INTO charges
            (id, payment_intent_id, merchant_id, amount, currency, status, payment_method_id, fee, net)
          VALUES ($1, $2, $3, $4, $5, 'succeeded', $6, $7, $8)
        `, [chargeId, intent.id, req.merchantId, intent.amount, intent.currency, paymentMethodId, fee, intent.amount - fee]);

        // Create ledger entries
        await createChargeEntries(client, {
          chargeId,
          paymentIntentId: intent.id,
          amount: intent.amount,
          merchantId: req.merchantId!,
        });

        return { chargeId, fee };
      });

      // Update metrics
      activePaymentIntents.dec({ status: previousStatus });
      activePaymentIntents.inc({ status: 'succeeded' });

      // Audit log: Payment confirmed and succeeded
      await auditLogger.logPaymentIntentConfirmed(
        { ...intent, status: 'succeeded', auth_code: authResult.authCode, payment_method_id: paymentMethodId },
        previousStatus,
        {
          ipAddress: req.ip,
          traceId: req.headers['x-trace-id'] as string,
          metadata: { charge_id: result.chargeId, fee: result.fee },
        }
      );

      // Send webhook
      await sendWebhook(req.merchantId!, 'payment_intent.succeeded', {
        id: intent.id,
        amount: intent.amount,
        currency: intent.currency,
      });

      const [s, ns] = process.hrtime(startTime);
      logger.info({
        event: 'payment_succeeded',
        intent_id: intent.id,
        amount: intent.amount,
        currency: intent.currency,
        charge_id: result.chargeId,
        duration_ms: ((s * 1000) + (ns / 1e6)).toFixed(2),
      });
    } else {
      // Manual capture - just update to requires_capture
      await query(`
        UPDATE payment_intents
        SET status = 'requires_capture', auth_code = $2, payment_method_id = $3
        WHERE id = $1
      `, [intent.id, authResult.authCode, paymentMethodId]);

      activePaymentIntents.dec({ status: previousStatus });
      activePaymentIntents.inc({ status: 'requires_capture' });

      logger.info({
        event: 'payment_authorized',
        intent_id: intent.id,
        amount: intent.amount,
        status: 'requires_capture',
      });
    }

    // Get updated intent
    const updatedResult = await query<PaymentIntentRow>(`SELECT * FROM payment_intents WHERE id = $1`, [intent.id]);
    const paymentIntent = formatPaymentIntent(updatedResult.rows[0]);

    res.json(paymentIntent);
  } catch (error) {
    const err = error as CardNetworkError;
    // Check for circuit breaker errors
    if (err.name === 'CardNetworkUnavailableError') {
      logger.warn({
        event: 'payment_processor_unavailable',
        intent_id: req.params.id,
        error_message: err.message,
      });

      res.status(503).json({
        error: {
          type: 'api_error',
          code: 'payment_processor_unavailable',
          message: 'Payment processor is temporarily unavailable. Please try again.',
        },
      });
      return;
    }

    logger.error({
      event: 'payment_intent_confirm_error',
      intent_id: req.params.id,
      error_message: err.message,
    });

    res.status(500).json({
      error: {
        type: 'api_error',
        message: 'Failed to confirm payment intent',
      },
    });
  }
});

/**
 * Capture a payment intent
 * POST /v1/payment_intents/:id/capture
 */
router.post('/:id/capture', idempotencyMiddleware, async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const startTime = process.hrtime();

  try {
    const { amount_to_capture } = req.body as CapturePaymentIntentBody;

    // Get payment intent
    const intentResult = await query<PaymentIntentRow>(`
      SELECT * FROM payment_intents
      WHERE id = $1 AND merchant_id = $2
    `, [req.params.id, req.merchantId]);

    if (intentResult.rows.length === 0) {
      res.status(404).json({
        error: {
          type: 'invalid_request_error',
          message: 'Payment intent not found',
        },
      });
      return;
    }

    const intent = intentResult.rows[0];

    // Validate state
    if (intent.status !== 'requires_capture') {
      res.status(400).json({
        error: {
          type: 'invalid_request_error',
          message: `Cannot capture payment intent in status: ${intent.status}`,
        },
      });
      return;
    }

    // Determine capture amount
    const captureAmount = amount_to_capture || intent.amount;
    if (captureAmount > intent.amount) {
      res.status(400).json({
        error: {
          type: 'invalid_request_error',
          message: 'Capture amount cannot exceed authorized amount',
          param: 'amount_to_capture',
        },
      });
      return;
    }

    // Capture with card network
    const captureParams: CaptureParams = {
      authCode: intent.auth_code!,
      amount: captureAmount,
      currency: intent.currency,
    };
    const captureResult = await capture(captureParams);

    if (!captureResult.captured) {
      res.status(402).json({
        error: {
          type: 'card_error',
          code: 'capture_failed',
          message: 'Failed to capture payment',
        },
      });
      return;
    }

    // Process capture
    const result = await transaction(async (client: PoolClient) => {
      // Update intent
      await client.query(`
        UPDATE payment_intents
        SET status = 'succeeded', amount = $2
        WHERE id = $1
      `, [intent.id, captureAmount]);

      // Create charge
      const fee = calculateFee(captureAmount);
      const chargeId = uuidv4();

      await client.query(`
        INSERT INTO charges
          (id, payment_intent_id, merchant_id, amount, currency, status, payment_method_id, fee, net)
        VALUES ($1, $2, $3, $4, $5, 'succeeded', $6, $7, $8)
      `, [chargeId, intent.id, req.merchantId, captureAmount, intent.currency, intent.payment_method_id, fee, captureAmount - fee]);

      // Create ledger entries
      await createChargeEntries(client, {
        chargeId,
        paymentIntentId: intent.id,
        amount: captureAmount,
        merchantId: req.merchantId!,
      });

      return { chargeId, fee };
    });

    // Update metrics
    activePaymentIntents.dec({ status: 'requires_capture' });
    activePaymentIntents.inc({ status: 'succeeded' });

    // Audit log: Payment captured
    await auditLogger.logPaymentIntentCaptured(intent, captureAmount, {
      ipAddress: req.ip,
      traceId: req.headers['x-trace-id'] as string,
      metadata: { charge_id: result.chargeId },
    });

    // Send webhook
    await sendWebhook(req.merchantId!, 'payment_intent.succeeded', {
      id: intent.id,
      amount: captureAmount,
      currency: intent.currency,
    });

    const [s, ns] = process.hrtime(startTime);
    logger.info({
      event: 'payment_captured',
      intent_id: intent.id,
      captured_amount: captureAmount,
      duration_ms: ((s * 1000) + (ns / 1e6)).toFixed(2),
    });

    // Get updated intent
    const updatedResult = await query<PaymentIntentRow>(`SELECT * FROM payment_intents WHERE id = $1`, [intent.id]);
    res.json(formatPaymentIntent(updatedResult.rows[0]));
  } catch (error) {
    const err = error as CardNetworkError;
    if (err.name === 'CardNetworkUnavailableError') {
      res.status(503).json({
        error: {
          type: 'api_error',
          code: 'payment_processor_unavailable',
          message: 'Payment processor is temporarily unavailable. Please try again.',
        },
      });
      return;
    }

    logger.error({
      event: 'payment_intent_capture_error',
      intent_id: req.params.id,
      error_message: err.message,
    });

    res.status(500).json({
      error: {
        type: 'api_error',
        message: 'Failed to capture payment intent',
      },
    });
  }
});

/**
 * Cancel a payment intent
 * POST /v1/payment_intents/:id/cancel
 */
router.post('/:id/cancel', async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const { cancellation_reason } = req.body as CancelPaymentIntentBody;

    // Get payment intent
    const intentResult = await query<PaymentIntentRow>(`
      SELECT * FROM payment_intents
      WHERE id = $1 AND merchant_id = $2
    `, [req.params.id, req.merchantId]);

    if (intentResult.rows.length === 0) {
      res.status(404).json({
        error: {
          type: 'invalid_request_error',
          message: 'Payment intent not found',
        },
      });
      return;
    }

    const intent = intentResult.rows[0];
    const previousStatus = intent.status;

    // Validate state
    const cancelableStatuses = ['requires_payment_method', 'requires_confirmation', 'requires_action', 'requires_capture'];
    if (!cancelableStatuses.includes(intent.status)) {
      res.status(400).json({
        error: {
          type: 'invalid_request_error',
          message: `Cannot cancel payment intent in status: ${intent.status}`,
        },
      });
      return;
    }

    // Update intent
    await query(`
      UPDATE payment_intents
      SET status = 'canceled', metadata = metadata || $2
      WHERE id = $1
    `, [intent.id, JSON.stringify({ cancellation_reason: cancellation_reason || 'requested' })]);

    // Update metrics
    activePaymentIntents.dec({ status: previousStatus });
    activePaymentIntents.inc({ status: 'canceled' });

    // Send webhook
    await sendWebhook(req.merchantId!, 'payment_intent.canceled', {
      id: intent.id,
      cancellation_reason,
    });

    logger.info({
      event: 'payment_canceled',
      intent_id: intent.id,
      previous_status: previousStatus,
      reason: cancellation_reason,
    });

    // Get updated intent
    const updatedResult = await query<PaymentIntentRow>(`SELECT * FROM payment_intents WHERE id = $1`, [intent.id]);
    res.json(formatPaymentIntent(updatedResult.rows[0]));
  } catch (error) {
    const err = error as Error;
    logger.error({
      event: 'payment_intent_cancel_error',
      intent_id: req.params.id,
      error_message: err.message,
    });
    res.status(500).json({
      error: {
        type: 'api_error',
        message: 'Failed to cancel payment intent',
      },
    });
  }
});

/**
 * Update a payment intent
 * POST /v1/payment_intents/:id
 */
router.post('/:id', async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const { amount, currency, description, metadata } = req.body as UpdatePaymentIntentBody;

    // Get payment intent
    const intentResult = await query<PaymentIntentRow>(`
      SELECT * FROM payment_intents
      WHERE id = $1 AND merchant_id = $2
    `, [req.params.id, req.merchantId]);

    if (intentResult.rows.length === 0) {
      res.status(404).json({
        error: {
          type: 'invalid_request_error',
          message: 'Payment intent not found',
        },
      });
      return;
    }

    const intent = intentResult.rows[0];

    // Only allow updates for certain states
    const updatableStatuses = ['requires_payment_method', 'requires_confirmation'];
    if (!updatableStatuses.includes(intent.status)) {
      res.status(400).json({
        error: {
          type: 'invalid_request_error',
          message: `Cannot update payment intent in status: ${intent.status}`,
        },
      });
      return;
    }

    // Build update query
    const updates: string[] = [];
    const params: unknown[] = [intent.id];
    let paramIndex = 2;

    if (amount !== undefined) {
      updates.push(`amount = $${paramIndex++}`);
      params.push(amount);
    }

    if (currency !== undefined) {
      updates.push(`currency = $${paramIndex++}`);
      params.push(currency.toLowerCase());
    }

    if (description !== undefined) {
      updates.push(`description = $${paramIndex++}`);
      params.push(description);
    }

    if (metadata !== undefined) {
      updates.push(`metadata = $${paramIndex++}`);
      params.push(JSON.stringify(metadata));
    }

    if (updates.length === 0) {
      res.json(formatPaymentIntent(intent));
      return;
    }

    await query(`
      UPDATE payment_intents
      SET ${updates.join(', ')}
      WHERE id = $1
    `, params);

    logger.info({
      event: 'payment_intent_updated',
      intent_id: intent.id,
      updates: { amount, currency, description },
    });

    // Get updated intent
    const updatedResult = await query<PaymentIntentRow>(`SELECT * FROM payment_intents WHERE id = $1`, [intent.id]);
    res.json(formatPaymentIntent(updatedResult.rows[0]));
  } catch (error) {
    const err = error as Error;
    logger.error({
      event: 'payment_intent_update_error',
      intent_id: req.params.id,
      error_message: err.message,
    });
    res.status(500).json({
      error: {
        type: 'api_error',
        message: 'Failed to update payment intent',
      },
    });
  }
});

/**
 * Format payment intent for API response
 */
function formatPaymentIntent(row: PaymentIntentRow): PaymentIntentResponse {
  const response: PaymentIntentResponse = {
    id: row.id,
    object: 'payment_intent',
    amount: row.amount,
    currency: row.currency,
    status: row.status,
    customer: row.customer_id,
    payment_method: row.payment_method_id,
    capture_method: row.capture_method,
    description: row.description,
    metadata: row.metadata || {},
    created: Math.floor(new Date(row.created_at).getTime() / 1000),
    livemode: false,
  };

  if (row.decline_code) {
    response.last_payment_error = {
      decline_code: row.decline_code,
      message: row.error_message,
    };
  }

  return response;
}

/**
 * Get human-readable decline message
 */
function getDeclineMessage(declineCode: string): string {
  const messages: Record<string, string> = {
    insufficient_funds: 'The card has insufficient funds to complete the purchase.',
    card_declined: 'The card was declined.',
    expired_card: 'The card has expired.',
    incorrect_cvc: "The card's security code is incorrect.",
    processing_error: 'An error occurred while processing the card.',
    fraudulent: 'The payment was declined due to suspected fraud.',
  };

  return messages[declineCode] || 'The card was declined.';
}

export default router;
