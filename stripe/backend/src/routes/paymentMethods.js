import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { query } from '../db/pool.js';
import { authenticateApiKey } from '../middleware/auth.js';
import { generateCardToken, isValidCardNumber, maskCardNumber } from '../utils/helpers.js';
import { getCardBrand, isCardExpired } from '../services/cardNetwork.js';

const router = Router();

// All routes require authentication
router.use(authenticateApiKey);

/**
 * Create a payment method
 * POST /v1/payment_methods
 */
router.post('/', async (req, res) => {
  try {
    const { type = 'card', card, customer, billing_details } = req.body;

    // Validate type
    if (type !== 'card') {
      return res.status(400).json({
        error: {
          type: 'invalid_request_error',
          message: 'Only card payment methods are supported',
          param: 'type',
        },
      });
    }

    // Validate card details
    if (!card) {
      return res.status(400).json({
        error: {
          type: 'invalid_request_error',
          message: 'Card details are required',
          param: 'card',
        },
      });
    }

    const { number, exp_month, exp_year, cvc } = card;

    if (!number || !exp_month || !exp_year || !cvc) {
      return res.status(400).json({
        error: {
          type: 'invalid_request_error',
          message: 'Card number, expiration, and CVC are required',
          param: 'card',
        },
      });
    }

    // Clean card number
    const cleanNumber = number.replace(/\s/g, '');

    // Validate card number (Luhn check)
    if (!isValidCardNumber(cleanNumber)) {
      return res.status(400).json({
        error: {
          type: 'card_error',
          code: 'invalid_number',
          message: 'Invalid card number',
          param: 'card[number]',
        },
      });
    }

    // Validate expiration
    if (exp_month < 1 || exp_month > 12) {
      return res.status(400).json({
        error: {
          type: 'card_error',
          code: 'invalid_expiry_month',
          message: 'Invalid expiration month',
          param: 'card[exp_month]',
        },
      });
    }

    if (isCardExpired(exp_month, exp_year)) {
      return res.status(400).json({
        error: {
          type: 'card_error',
          code: 'expired_card',
          message: 'Card has expired',
          param: 'card[exp_year]',
        },
      });
    }

    // Validate CVC
    if (!/^\d{3,4}$/.test(cvc)) {
      return res.status(400).json({
        error: {
          type: 'card_error',
          code: 'invalid_cvc',
          message: 'Invalid CVC',
          param: 'card[cvc]',
        },
      });
    }

    // Validate customer if provided
    if (customer) {
      const customerResult = await query(`
        SELECT id FROM customers
        WHERE id = $1 AND merchant_id = $2
      `, [customer, req.merchantId]);

      if (customerResult.rows.length === 0) {
        return res.status(400).json({
          error: {
            type: 'invalid_request_error',
            message: 'Customer not found',
            param: 'customer',
          },
        });
      }
    }

    const id = uuidv4();
    const cardToken = generateCardToken(cleanNumber);
    const cardBrand = getCardBrand(cleanNumber);
    const cardLast4 = cleanNumber.slice(-4);
    const cardBin = cleanNumber.slice(0, 6);

    const result = await query(`
      INSERT INTO payment_methods
        (id, customer_id, merchant_id, type, card_token, card_last4, card_brand,
         card_exp_month, card_exp_year, card_bin, billing_details)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      RETURNING *
    `, [
      id,
      customer || null,
      req.merchantId,
      type,
      cardToken,
      cardLast4,
      cardBrand,
      exp_month,
      exp_year,
      cardBin,
      JSON.stringify(billing_details || {}),
    ]);

    res.status(201).json(formatPaymentMethod(result.rows[0]));
  } catch (error) {
    console.error('Create payment method error:', error);
    res.status(500).json({
      error: {
        type: 'api_error',
        message: 'Failed to create payment method',
      },
    });
  }
});

/**
 * Get a payment method
 * GET /v1/payment_methods/:id
 */
router.get('/:id', async (req, res) => {
  try {
    const result = await query(`
      SELECT * FROM payment_methods
      WHERE id = $1 AND merchant_id = $2
    `, [req.params.id, req.merchantId]);

    if (result.rows.length === 0) {
      return res.status(404).json({
        error: {
          type: 'invalid_request_error',
          message: 'Payment method not found',
        },
      });
    }

    res.json(formatPaymentMethod(result.rows[0]));
  } catch (error) {
    console.error('Get payment method error:', error);
    res.status(500).json({
      error: {
        type: 'api_error',
        message: 'Failed to retrieve payment method',
      },
    });
  }
});

/**
 * List payment methods
 * GET /v1/payment_methods
 */
router.get('/', async (req, res) => {
  try {
    const { limit = 10, offset = 0, customer, type = 'card' } = req.query;

    let queryText = `
      SELECT * FROM payment_methods
      WHERE merchant_id = $1 AND type = $2
    `;
    const params = [req.merchantId, type];
    let paramIndex = 3;

    if (customer) {
      queryText += ` AND customer_id = $${paramIndex}`;
      params.push(customer);
      paramIndex++;
    }

    queryText += ` ORDER BY created_at DESC LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
    params.push(parseInt(limit), parseInt(offset));

    const result = await query(queryText, params);

    // Get total count
    let countQuery = `
      SELECT COUNT(*) FROM payment_methods
      WHERE merchant_id = $1 AND type = $2
    `;
    const countParams = [req.merchantId, type];

    if (customer) {
      countQuery += ` AND customer_id = $3`;
      countParams.push(customer);
    }

    const countResult = await query(countQuery, countParams);

    res.json({
      object: 'list',
      data: result.rows.map(formatPaymentMethod),
      has_more: parseInt(offset) + result.rows.length < parseInt(countResult.rows[0].count),
      total_count: parseInt(countResult.rows[0].count),
    });
  } catch (error) {
    console.error('List payment methods error:', error);
    res.status(500).json({
      error: {
        type: 'api_error',
        message: 'Failed to list payment methods',
      },
    });
  }
});

/**
 * Attach payment method to customer
 * POST /v1/payment_methods/:id/attach
 */
router.post('/:id/attach', async (req, res) => {
  try {
    const { customer } = req.body;

    if (!customer) {
      return res.status(400).json({
        error: {
          type: 'invalid_request_error',
          message: 'Customer is required',
          param: 'customer',
        },
      });
    }

    // Validate customer
    const customerResult = await query(`
      SELECT id FROM customers
      WHERE id = $1 AND merchant_id = $2
    `, [customer, req.merchantId]);

    if (customerResult.rows.length === 0) {
      return res.status(400).json({
        error: {
          type: 'invalid_request_error',
          message: 'Customer not found',
          param: 'customer',
        },
      });
    }

    // Get payment method
    const pmResult = await query(`
      SELECT * FROM payment_methods
      WHERE id = $1 AND merchant_id = $2
    `, [req.params.id, req.merchantId]);

    if (pmResult.rows.length === 0) {
      return res.status(404).json({
        error: {
          type: 'invalid_request_error',
          message: 'Payment method not found',
        },
      });
    }

    // Attach to customer
    const result = await query(`
      UPDATE payment_methods
      SET customer_id = $2
      WHERE id = $1
      RETURNING *
    `, [req.params.id, customer]);

    res.json(formatPaymentMethod(result.rows[0]));
  } catch (error) {
    console.error('Attach payment method error:', error);
    res.status(500).json({
      error: {
        type: 'api_error',
        message: 'Failed to attach payment method',
      },
    });
  }
});

/**
 * Detach payment method from customer
 * POST /v1/payment_methods/:id/detach
 */
router.post('/:id/detach', async (req, res) => {
  try {
    // Get payment method
    const pmResult = await query(`
      SELECT * FROM payment_methods
      WHERE id = $1 AND merchant_id = $2
    `, [req.params.id, req.merchantId]);

    if (pmResult.rows.length === 0) {
      return res.status(404).json({
        error: {
          type: 'invalid_request_error',
          message: 'Payment method not found',
        },
      });
    }

    // Detach from customer
    const result = await query(`
      UPDATE payment_methods
      SET customer_id = NULL
      WHERE id = $1
      RETURNING *
    `, [req.params.id]);

    res.json(formatPaymentMethod(result.rows[0]));
  } catch (error) {
    console.error('Detach payment method error:', error);
    res.status(500).json({
      error: {
        type: 'api_error',
        message: 'Failed to detach payment method',
      },
    });
  }
});

/**
 * Format payment method for API response
 */
function formatPaymentMethod(row) {
  return {
    id: row.id,
    object: 'payment_method',
    type: row.type,
    card: {
      brand: row.card_brand,
      last4: row.card_last4,
      exp_month: row.card_exp_month,
      exp_year: row.card_exp_year,
      country: row.card_country,
    },
    customer: row.customer_id,
    billing_details: row.billing_details || {},
    created: Math.floor(new Date(row.created_at).getTime() / 1000),
    livemode: false,
  };
}

export default router;
