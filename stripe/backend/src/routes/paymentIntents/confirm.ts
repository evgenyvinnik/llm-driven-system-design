/**
 * Confirm payment intent handler
 * @module paymentIntents/confirm
 *
 * POST /v1/payment_intents/:id/confirm
 */

import { Response } from 'express';
import { query } from '../../db/pool.js';
import { AuthenticatedRequest } from '../../middleware/auth.js';
import { assessRisk } from '../../services/fraud.js';
import { authorize, AuthorizeParams } from '../../services/cardNetwork.js';
import logger from '../../shared/logger.js';
import { auditLogger } from '../../shared/audit.js';
import { recordFraudCheck } from '../../shared/metrics.js';
import type {
  PaymentIntentRow,
  PaymentMethodRow,
  ConfirmPaymentIntentBody,
  CardNetworkError,
} from './types.js';
import { CONFIRMABLE_STATUSES } from './utils.js';
import {
  handleBlockedPayment,
  handleReviewPayment,
  handleDeclinedPayment,
  handleAutomaticCapture,
  handleManualCapture,
} from './confirmHelpers.js';

/**
 * @description Confirms a payment intent and initiates the payment process.
 * Performs fraud risk assessment, authorizes the payment with the card network,
 * and either captures immediately (automatic) or awaits manual capture.
 *
 * @param {AuthenticatedRequest} req - Express request with authenticated merchant context
 * @param {string} req.params.id - The payment intent ID to confirm
 * @param {ConfirmPaymentIntentBody} req.body - Confirmation parameters
 * @param {string} [req.body.payment_method] - Payment method ID to use (optional if already attached)
 * @param {Response} res - Express response object
 * @returns {Promise<void>} Responds with the confirmed payment intent or an error
 *
 * @throws {400} Payment intent is not confirmable, or payment method is missing/invalid
 * @throws {402} Payment declined due to fraud or card network rejection
 * @throws {404} Payment intent not found
 * @throws {500} Database or internal server error
 * @throws {503} Payment processor temporarily unavailable
 */
export async function confirmPaymentIntent(
  req: AuthenticatedRequest,
  res: Response
): Promise<void> {
  const startTime = process.hrtime();

  try {
    const { payment_method } = req.body as ConfirmPaymentIntentBody;

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
    const previousStatus = intent.status;

    // Validate state
    if (!CONFIRMABLE_STATUSES.includes(intent.status)) {
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

    const pmResult = await query<PaymentMethodRow>(
      `
      SELECT * FROM payment_methods
      WHERE id = $1 AND merchant_id = $2
    `,
      [paymentMethodId, req.merchantId]
    );

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
      riskResult.signals.map((s) => s.rule),
      {
        ipAddress: req.ip,
        traceId: req.headers['x-trace-id'] as string,
      }
    );

    // Block high-risk payments
    if (riskResult.decision === 'block') {
      await handleBlockedPayment(req, res, intent, previousStatus, riskResult);
      return;
    }

    // Require 3DS for review decisions
    if (riskResult.decision === 'review') {
      await handleReviewPayment(req, res, intent, previousStatus, paymentMethodId, riskResult);
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
      await handleDeclinedPayment(req, res, intent, previousStatus, paymentMethodId, authResult);
      return;
    }

    // Process successful authorization
    if (intent.capture_method === 'automatic') {
      await handleAutomaticCapture(
        req,
        res,
        intent,
        previousStatus,
        paymentMethodId,
        authResult,
        startTime
      );
    } else {
      await handleManualCapture(req, res, intent, previousStatus, paymentMethodId, authResult);
    }
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
}
