/**
 * Capture payment intent handler
 * @module paymentIntents/capture
 *
 * POST /v1/payment_intents/:id/capture
 */

import { Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { query, transaction } from '../../db/pool.js';
import { AuthenticatedRequest } from '../../middleware/auth.js';
import { createChargeEntries, calculateFee } from '../../services/ledger.js';
import { capture, CaptureParams } from '../../services/cardNetwork.js';
import { sendWebhook } from '../../services/webhooks.js';
import logger from '../../shared/logger.js';
import { auditLogger, PaymentIntentRow as AuditPaymentIntentRow } from '../../shared/audit.js';
import { activePaymentIntents } from '../../shared/metrics.js';
import type { PoolClient } from 'pg';
import type { PaymentIntentRow, CapturePaymentIntentBody, CardNetworkError } from './types.js';
import { formatPaymentIntent } from './utils.js';

/**
 * @description Captures a previously authorized payment intent.
 * Only payment intents in 'requires_capture' status (manual capture mode) can be captured.
 * This completes the payment and creates a charge with ledger entries.
 *
 * @param {AuthenticatedRequest} req - Express request with authenticated merchant context
 * @param {string} req.params.id - The payment intent ID to capture
 * @param {CapturePaymentIntentBody} req.body - Capture parameters
 * @param {number} [req.body.amount_to_capture] - Amount to capture in cents (default: full authorized amount)
 * @param {Response} res - Express response object
 * @returns {Promise<void>} Responds with the captured payment intent or an error
 *
 * @throws {400} Payment intent is not in 'requires_capture' status, or capture amount exceeds authorized amount
 * @throws {402} Card network capture failed
 * @throws {404} Payment intent not found
 * @throws {500} Database or internal server error
 * @throws {503} Payment processor temporarily unavailable
 */
export async function capturePaymentIntent(
  req: AuthenticatedRequest,
  res: Response
): Promise<void> {
  const startTime = process.hrtime();

  try {
    const { amount_to_capture } = req.body as CapturePaymentIntentBody;

    // Get payment intent
    const intentResult = await query<PaymentIntentRow>(
      `
      SELECT * FROM payment_intents
      WHERE id = $1 AND merchant_id = $2
    `,
      [req.params.id, req.merchantId]
    );

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
      await client.query(
        `
        UPDATE payment_intents
        SET status = 'succeeded', amount = $2
        WHERE id = $1
      `,
        [intent.id, captureAmount]
      );

      // Create charge
      const fee = calculateFee(captureAmount);
      const chargeId = uuidv4();

      await client.query(
        `
        INSERT INTO charges
          (id, payment_intent_id, merchant_id, amount, currency, status, payment_method_id, fee, net)
        VALUES ($1, $2, $3, $4, $5, 'succeeded', $6, $7, $8)
      `,
        [
          chargeId,
          intent.id,
          req.merchantId,
          captureAmount,
          intent.currency,
          intent.payment_method_id,
          fee,
          captureAmount - fee,
        ]
      );

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
    await auditLogger.logPaymentIntentCaptured(intent as AuditPaymentIntentRow, captureAmount, {
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
      duration_ms: (s * 1000 + ns / 1e6).toFixed(2),
    });

    // Get updated intent
    const updatedResult = await query<PaymentIntentRow>(
      `SELECT * FROM payment_intents WHERE id = $1`,
      [intent.id]
    );
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
}
