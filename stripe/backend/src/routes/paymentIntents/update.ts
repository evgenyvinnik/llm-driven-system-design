/**
 * Update payment intent handler
 * @module paymentIntents/update
 *
 * POST /v1/payment_intents/:id
 */

import { Response } from 'express';
import { query } from '../../db/pool.js';
import { AuthenticatedRequest } from '../../middleware/auth.js';
import logger from '../../shared/logger.js';
import type { PaymentIntentRow, UpdatePaymentIntentBody } from './types.js';
import { formatPaymentIntent, UPDATABLE_STATUSES } from './utils.js';

/**
 * @description Updates a payment intent's amount, currency, description, or metadata.
 * Only payment intents in 'requires_payment_method' or 'requires_confirmation' status can be updated.
 *
 * @param {AuthenticatedRequest} req - Express request with authenticated merchant context
 * @param {string} req.params.id - The payment intent ID to update
 * @param {UpdatePaymentIntentBody} req.body - Update parameters
 * @param {number} [req.body.amount] - New payment amount in cents
 * @param {string} [req.body.currency] - New currency code
 * @param {string} [req.body.description] - New description
 * @param {Record<string, unknown>} [req.body.metadata] - New metadata (replaces existing)
 * @param {Response} res - Express response object
 * @returns {Promise<void>} Responds with the updated payment intent or an error
 *
 * @throws {400} Payment intent is in a non-updatable status
 * @throws {404} Payment intent not found
 * @throws {500} Database or internal server error
 */
export async function updatePaymentIntent(
  req: AuthenticatedRequest,
  res: Response
): Promise<void> {
  try {
    const { amount, currency, description, metadata } = req.body as UpdatePaymentIntentBody;

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

    // Only allow updates for certain states
    if (!UPDATABLE_STATUSES.includes(intent.status)) {
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

    await query(
      `
      UPDATE payment_intents
      SET ${updates.join(', ')}
      WHERE id = $1
    `,
      params
    );

    logger.info({
      event: 'payment_intent_updated',
      intent_id: intent.id,
      updates: { amount, currency, description },
    });

    // Get updated intent
    const updatedResult = await query<PaymentIntentRow>(
      `SELECT * FROM payment_intents WHERE id = $1`,
      [intent.id]
    );
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
}
