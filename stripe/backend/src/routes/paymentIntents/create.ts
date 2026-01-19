/**
 * Create payment intent handler
 * @module paymentIntents/create
 *
 * POST /v1/payment_intents
 */

import { Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { query } from '../../db/pool.js';
import { AuthenticatedRequest } from '../../middleware/auth.js';
import logger from '../../shared/logger.js';
import { auditLogger, PaymentIntentRow as AuditPaymentIntentRow } from '../../shared/audit.js';
import { paymentAmountCents, activePaymentIntents } from '../../shared/metrics.js';
import type { PaymentIntentRow, CreatePaymentIntentBody, DatabaseError } from './types.js';
import { formatPaymentIntent, VALID_CURRENCIES } from './utils.js';

/**
 * @description Creates a new payment intent for processing a payment.
 * The payment intent tracks the lifecycle of a payment from creation through confirmation and capture.
 *
 * @param {AuthenticatedRequest} req - Express request with authenticated merchant context
 * @param {CreatePaymentIntentBody} req.body - Payment intent creation parameters
 * @param {number} req.body.amount - Required. Payment amount in cents
 * @param {string} [req.body.currency='usd'] - Three-letter ISO currency code
 * @param {string} [req.body.customer] - Customer ID to associate with this payment
 * @param {string} [req.body.payment_method] - Payment method ID to attach
 * @param {string} [req.body.capture_method='automatic'] - 'automatic' or 'manual'
 * @param {string} [req.body.description] - Description for the payment
 * @param {Record<string, unknown>} [req.body.metadata={}] - Key-value metadata
 * @param {Response} res - Express response object
 * @returns {Promise<void>} Responds with the created payment intent or an error
 *
 * @throws {400} Invalid amount or unsupported currency
 * @throws {409} Idempotency key conflict
 * @throws {500} Database or internal server error
 */
export async function createPaymentIntent(
  req: AuthenticatedRequest,
  res: Response
): Promise<void> {
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
    if (!VALID_CURRENCIES.includes(currency.toLowerCase())) {
      res.status(400).json({
        error: {
          type: 'invalid_request_error',
          message: `Invalid currency. Supported: ${VALID_CURRENCIES.join(', ')}`,
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
    const result = await query<PaymentIntentRow>(
      `
      INSERT INTO payment_intents
        (id, merchant_id, customer_id, amount, currency, status, payment_method_id,
         capture_method, description, metadata, idempotency_key)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      RETURNING *
    `,
      [
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
      ]
    );

    const paymentIntent = formatPaymentIntent(result.rows[0]);

    // Record metrics
    paymentAmountCents.observe({ currency: currency.toLowerCase(), status: 'created' }, amount);
    activePaymentIntents.inc({ status });

    // Audit log: Payment intent created
    await auditLogger.logPaymentIntentCreated(result.rows[0] as AuditPaymentIntentRow, {
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
}
