import { Router } from 'express';
import { query } from '../db/pool.js';
import { authenticateApiKey } from '../middleware/auth.js';

const router = Router();

// All routes require authentication
router.use(authenticateApiKey);

/**
 * Get charges (derived from payment intents)
 * GET /v1/charges
 */
router.get('/', async (req, res) => {
  try {
    const { limit = 10, offset = 0, customer, payment_intent } = req.query;

    let queryText = `
      SELECT c.*, pm.card_last4, pm.card_brand
      FROM charges c
      LEFT JOIN payment_methods pm ON pm.id = c.payment_method_id
      WHERE c.merchant_id = $1
    `;
    const params = [req.merchantId];
    let paramIndex = 2;

    if (customer) {
      queryText += `
        AND c.payment_intent_id IN (
          SELECT id FROM payment_intents WHERE customer_id = $${paramIndex}
        )
      `;
      params.push(customer);
      paramIndex++;
    }

    if (payment_intent) {
      queryText += ` AND c.payment_intent_id = $${paramIndex}`;
      params.push(payment_intent);
      paramIndex++;
    }

    queryText += ` ORDER BY c.created_at DESC LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
    params.push(parseInt(limit), parseInt(offset));

    const result = await query(queryText, params);

    // Get total count
    const countResult = await query(`
      SELECT COUNT(*) FROM charges WHERE merchant_id = $1
    `, [req.merchantId]);

    res.json({
      object: 'list',
      data: result.rows.map(formatCharge),
      has_more: parseInt(offset) + result.rows.length < parseInt(countResult.rows[0].count),
      total_count: parseInt(countResult.rows[0].count),
    });
  } catch (error) {
    console.error('List charges error:', error);
    res.status(500).json({
      error: {
        type: 'api_error',
        message: 'Failed to list charges',
      },
    });
  }
});

/**
 * Get a charge
 * GET /v1/charges/:id
 */
router.get('/:id', async (req, res) => {
  try {
    const result = await query(`
      SELECT c.*, pm.card_last4, pm.card_brand
      FROM charges c
      LEFT JOIN payment_methods pm ON pm.id = c.payment_method_id
      WHERE c.id = $1 AND c.merchant_id = $2
    `, [req.params.id, req.merchantId]);

    if (result.rows.length === 0) {
      return res.status(404).json({
        error: {
          type: 'invalid_request_error',
          message: 'Charge not found',
        },
      });
    }

    res.json(formatCharge(result.rows[0]));
  } catch (error) {
    console.error('Get charge error:', error);
    res.status(500).json({
      error: {
        type: 'api_error',
        message: 'Failed to retrieve charge',
      },
    });
  }
});

/**
 * Format charge for API response
 */
function formatCharge(row) {
  return {
    id: row.id,
    object: 'charge',
    amount: row.amount,
    amount_refunded: row.amount_refunded,
    currency: row.currency,
    status: row.status,
    payment_intent: row.payment_intent_id,
    payment_method: row.payment_method_id,
    payment_method_details: row.card_last4 ? {
      type: 'card',
      card: {
        brand: row.card_brand,
        last4: row.card_last4,
      },
    } : null,
    description: row.description,
    metadata: row.metadata || {},
    fee: row.fee,
    net: row.net,
    created: Math.floor(new Date(row.created_at).getTime() / 1000),
    livemode: false,
    refunded: row.status === 'refunded',
    captured: true,
  };
}

export default router;
