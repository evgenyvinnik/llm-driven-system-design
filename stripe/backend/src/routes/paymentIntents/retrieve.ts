/**
 * Retrieve payment intent handlers
 * @module paymentIntents/retrieve
 *
 * GET /v1/payment_intents/:id
 * GET /v1/payment_intents
 */

import { Response } from 'express';
import { query } from '../../db/pool.js';
import { AuthenticatedRequest } from '../../middleware/auth.js';
import { getRiskAssessment } from '../../services/fraud.js';
import logger from '../../shared/logger.js';
import type { PaymentIntentRow } from './types.js';
import { formatPaymentIntent } from './utils.js';

/**
 * @description Retrieves a single payment intent by ID.
 * Returns the payment intent with its current status and any associated risk assessment.
 *
 * @param {AuthenticatedRequest} req - Express request with authenticated merchant context
 * @param {string} req.params.id - The payment intent ID to retrieve
 * @param {Response} res - Express response object
 * @returns {Promise<void>} Responds with the payment intent or an error
 *
 * @throws {404} Payment intent not found
 * @throws {500} Database or internal server error
 */
export async function getPaymentIntent(
  req: AuthenticatedRequest,
  res: Response
): Promise<void> {
  try {
    const result = await query<PaymentIntentRow>(
      `
      SELECT * FROM payment_intents
      WHERE id = $1 AND merchant_id = $2
    `,
      [req.params.id, req.merchantId]
    );

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
    const riskAssessment = await getRiskAssessment(req.params.id as string);
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
}

/**
 * @description Lists payment intents with optional filtering and pagination.
 * Returns a paginated list of payment intents for the authenticated merchant.
 *
 * @param {AuthenticatedRequest} req - Express request with authenticated merchant context
 * @param {string} [req.query.limit='10'] - Maximum number of results to return
 * @param {string} [req.query.offset='0'] - Number of results to skip for pagination
 * @param {string} [req.query.status] - Filter by payment intent status
 * @param {string} [req.query.customer] - Filter by customer ID
 * @param {Response} res - Express response object
 * @returns {Promise<void>} Responds with a paginated list of payment intents
 *
 * @throws {500} Database or internal server error
 */
export async function listPaymentIntents(
  req: AuthenticatedRequest,
  res: Response
): Promise<void> {
  try {
    const {
      limit = '10',
      offset = '0',
      status,
      customer,
    } = req.query as {
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
}
