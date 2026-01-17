import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { query, transaction } from '../db/pool.js';
import { authenticateApiKey } from '../middleware/auth.js';
import { idempotencyMiddleware } from '../middleware/idempotency.js';
import { createRefundEntries } from '../services/ledger.js';
import { refund as processRefund } from '../services/cardNetwork.js';
import { sendWebhook } from '../services/webhooks.js';

// Import shared modules for observability
import logger from '../shared/logger.js';
import { auditLogger } from '../shared/audit.js';
import { refundsTotal, refundAmountCents } from '../shared/metrics.js';

const router = Router();

// All routes require authentication
router.use(authenticateApiKey);

/**
 * Create a refund
 * POST /v1/refunds
 */
router.post('/', idempotencyMiddleware, async (req, res) => {
  try {
    const { payment_intent, charge, amount, reason, metadata = {} } = req.body;

    // Need either payment_intent or charge
    if (!payment_intent && !charge) {
      return res.status(400).json({
        error: {
          type: 'invalid_request_error',
          message: 'Either payment_intent or charge is required',
        },
      });
    }

    // Get charge (either by ID or by payment_intent)
    let chargeResult;
    if (charge) {
      chargeResult = await query(`
        SELECT c.*, pi.merchant_id as pi_merchant_id
        FROM charges c
        JOIN payment_intents pi ON pi.id = c.payment_intent_id
        WHERE c.id = $1 AND c.merchant_id = $2
      `, [charge, req.merchantId]);
    } else {
      chargeResult = await query(`
        SELECT c.*, pi.merchant_id as pi_merchant_id
        FROM charges c
        JOIN payment_intents pi ON pi.id = c.payment_intent_id
        WHERE c.payment_intent_id = $1 AND c.merchant_id = $2
      `, [payment_intent, req.merchantId]);
    }

    if (chargeResult.rows.length === 0) {
      return res.status(404).json({
        error: {
          type: 'invalid_request_error',
          message: 'Charge not found',
        },
      });
    }

    const chargeRecord = chargeResult.rows[0];

    // Check charge status
    if (chargeRecord.status !== 'succeeded' && chargeRecord.status !== 'partially_refunded') {
      return res.status(400).json({
        error: {
          type: 'invalid_request_error',
          message: `Cannot refund a charge in status: ${chargeRecord.status}`,
        },
      });
    }

    // Calculate refund amount
    const availableToRefund = chargeRecord.amount - chargeRecord.amount_refunded;
    const refundAmount = amount || availableToRefund;

    if (refundAmount <= 0) {
      return res.status(400).json({
        error: {
          type: 'invalid_request_error',
          message: 'Refund amount must be positive',
          param: 'amount',
        },
      });
    }

    if (refundAmount > availableToRefund) {
      return res.status(400).json({
        error: {
          type: 'invalid_request_error',
          message: `Cannot refund more than ${availableToRefund} cents (already refunded ${chargeRecord.amount_refunded})`,
          param: 'amount',
        },
      });
    }

    // Process refund with card network
    const refundResult = await processRefund({
      authCode: null, // Would be stored on charge in production
      amount: refundAmount,
      currency: chargeRecord.currency,
    });

    if (!refundResult.refunded) {
      return res.status(402).json({
        error: {
          type: 'card_error',
          code: 'refund_failed',
          message: 'Failed to process refund with card network',
        },
      });
    }

    // Create refund in database
    const id = uuidv4();

    const result = await transaction(async (client) => {
      // Create refund record
      await client.query(`
        INSERT INTO refunds
          (id, charge_id, payment_intent_id, amount, reason, status, metadata)
        VALUES ($1, $2, $3, $4, $5, 'succeeded', $6)
      `, [id, chargeRecord.id, chargeRecord.payment_intent_id, refundAmount, reason || null, JSON.stringify(metadata)]);

      // Update charge
      const newAmountRefunded = chargeRecord.amount_refunded + refundAmount;
      const newStatus = newAmountRefunded >= chargeRecord.amount ? 'refunded' : 'partially_refunded';

      await client.query(`
        UPDATE charges
        SET amount_refunded = $2, status = $3
        WHERE id = $1
      `, [chargeRecord.id, newAmountRefunded, newStatus]);

      // Create ledger entries
      await createRefundEntries(client, {
        refundId: id,
        chargeId: chargeRecord.id,
        paymentIntentId: chargeRecord.payment_intent_id,
        amount: refundAmount,
        merchantId: req.merchantId,
        originalFee: chargeRecord.fee,
      });

      return { id, newStatus, newAmountRefunded };
    });

    // Get the created refund
    const refundData = await query(`SELECT * FROM refunds WHERE id = $1`, [id]);
    const refund = refundData.rows[0];

    // Record metrics
    refundsTotal.inc({ status: 'succeeded', reason: reason || 'none' });
    refundAmountCents.observe(refundAmount);

    // Audit log: Refund created
    await auditLogger.logRefundCreated(refund, chargeRecord, {
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
      traceId: req.headers['x-trace-id'],
    });

    // Log the event
    logger.info({
      event: 'refund_created',
      refund_id: id,
      charge_id: chargeRecord.id,
      amount: refundAmount,
      reason,
      merchant_id: req.merchantId,
    });

    // Send webhook
    await sendWebhook(req.merchantId, 'charge.refunded', {
      id: chargeRecord.id,
      refund_id: id,
      amount_refunded: refundAmount,
    });

    res.status(201).json(formatRefund(refund));
  } catch (error) {
    // Check for circuit breaker errors
    if (error.name === 'CardNetworkUnavailableError') {
      logger.warn({
        event: 'refund_processor_unavailable',
        error_message: error.message,
      });

      return res.status(503).json({
        error: {
          type: 'api_error',
          code: 'payment_processor_unavailable',
          message: 'Refund processor is temporarily unavailable. Please try again.',
        },
      });
    }

    logger.error({
      event: 'refund_create_error',
      error_message: error.message,
      merchant_id: req.merchantId,
    });
    res.status(500).json({
      error: {
        type: 'api_error',
        message: 'Failed to create refund',
      },
    });
  }
});

/**
 * Get a refund
 * GET /v1/refunds/:id
 */
router.get('/:id', async (req, res) => {
  try {
    const result = await query(`
      SELECT r.*, c.merchant_id
      FROM refunds r
      JOIN charges c ON c.id = r.charge_id
      WHERE r.id = $1 AND c.merchant_id = $2
    `, [req.params.id, req.merchantId]);

    if (result.rows.length === 0) {
      return res.status(404).json({
        error: {
          type: 'invalid_request_error',
          message: 'Refund not found',
        },
      });
    }

    res.json(formatRefund(result.rows[0]));
  } catch (error) {
    console.error('Get refund error:', error);
    res.status(500).json({
      error: {
        type: 'api_error',
        message: 'Failed to retrieve refund',
      },
    });
  }
});

/**
 * List refunds
 * GET /v1/refunds
 */
router.get('/', async (req, res) => {
  try {
    const { limit = 10, offset = 0, payment_intent, charge } = req.query;

    let queryText = `
      SELECT r.*, c.merchant_id
      FROM refunds r
      JOIN charges c ON c.id = r.charge_id
      WHERE c.merchant_id = $1
    `;
    const params = [req.merchantId];
    let paramIndex = 2;

    if (payment_intent) {
      queryText += ` AND r.payment_intent_id = $${paramIndex}`;
      params.push(payment_intent);
      paramIndex++;
    }

    if (charge) {
      queryText += ` AND r.charge_id = $${paramIndex}`;
      params.push(charge);
      paramIndex++;
    }

    queryText += ` ORDER BY r.created_at DESC LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
    params.push(parseInt(limit), parseInt(offset));

    const result = await query(queryText, params);

    // Get total count
    let countQuery = `
      SELECT COUNT(*)
      FROM refunds r
      JOIN charges c ON c.id = r.charge_id
      WHERE c.merchant_id = $1
    `;
    const countParams = [req.merchantId];

    if (payment_intent) {
      countQuery += ` AND r.payment_intent_id = $2`;
      countParams.push(payment_intent);
    }

    const countResult = await query(countQuery, countParams);

    res.json({
      object: 'list',
      data: result.rows.map(formatRefund),
      has_more: parseInt(offset) + result.rows.length < parseInt(countResult.rows[0].count),
      total_count: parseInt(countResult.rows[0].count),
    });
  } catch (error) {
    console.error('List refunds error:', error);
    res.status(500).json({
      error: {
        type: 'api_error',
        message: 'Failed to list refunds',
      },
    });
  }
});

/**
 * Format refund for API response
 */
function formatRefund(row) {
  return {
    id: row.id,
    object: 'refund',
    amount: row.amount,
    charge: row.charge_id,
    payment_intent: row.payment_intent_id,
    reason: row.reason,
    status: row.status,
    metadata: row.metadata || {},
    created: Math.floor(new Date(row.created_at).getTime() / 1000),
  };
}

export default router;
