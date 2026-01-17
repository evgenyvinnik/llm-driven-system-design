import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { query } from '../db/pool.js';
import { authenticateApiKey } from '../middleware/auth.js';
import { isValidEmail } from '../utils/helpers.js';

const router = Router();

// All routes require authentication
router.use(authenticateApiKey);

/**
 * Create a customer
 * POST /v1/customers
 */
router.post('/', async (req, res) => {
  try {
    const { email, name, phone, metadata = {} } = req.body;

    // Validate email if provided
    if (email && !isValidEmail(email)) {
      return res.status(400).json({
        error: {
          type: 'invalid_request_error',
          message: 'Invalid email format',
          param: 'email',
        },
      });
    }

    const id = uuidv4();

    const result = await query(`
      INSERT INTO customers (id, merchant_id, email, name, phone, metadata)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING *
    `, [id, req.merchantId, email || null, name || null, phone || null, JSON.stringify(metadata)]);

    res.status(201).json(formatCustomer(result.rows[0]));
  } catch (error) {
    console.error('Create customer error:', error);
    res.status(500).json({
      error: {
        type: 'api_error',
        message: 'Failed to create customer',
      },
    });
  }
});

/**
 * Get a customer
 * GET /v1/customers/:id
 */
router.get('/:id', async (req, res) => {
  try {
    const result = await query(`
      SELECT * FROM customers
      WHERE id = $1 AND merchant_id = $2
    `, [req.params.id, req.merchantId]);

    if (result.rows.length === 0) {
      return res.status(404).json({
        error: {
          type: 'invalid_request_error',
          message: 'Customer not found',
        },
      });
    }

    res.json(formatCustomer(result.rows[0]));
  } catch (error) {
    console.error('Get customer error:', error);
    res.status(500).json({
      error: {
        type: 'api_error',
        message: 'Failed to retrieve customer',
      },
    });
  }
});

/**
 * List customers
 * GET /v1/customers
 */
router.get('/', async (req, res) => {
  try {
    const { limit = 10, offset = 0, email } = req.query;

    let queryText = `
      SELECT * FROM customers
      WHERE merchant_id = $1
    `;
    const params = [req.merchantId];
    let paramIndex = 2;

    if (email) {
      queryText += ` AND email = $${paramIndex}`;
      params.push(email);
      paramIndex++;
    }

    queryText += ` ORDER BY created_at DESC LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
    params.push(parseInt(limit), parseInt(offset));

    const result = await query(queryText, params);

    // Get total count
    const countResult = await query(`
      SELECT COUNT(*) FROM customers WHERE merchant_id = $1
    `, [req.merchantId]);

    res.json({
      object: 'list',
      data: result.rows.map(formatCustomer),
      has_more: parseInt(offset) + result.rows.length < parseInt(countResult.rows[0].count),
      total_count: parseInt(countResult.rows[0].count),
    });
  } catch (error) {
    console.error('List customers error:', error);
    res.status(500).json({
      error: {
        type: 'api_error',
        message: 'Failed to list customers',
      },
    });
  }
});

/**
 * Update a customer
 * POST /v1/customers/:id
 */
router.post('/:id', async (req, res) => {
  try {
    const { email, name, phone, metadata } = req.body;

    // Get existing customer
    const existing = await query(`
      SELECT * FROM customers
      WHERE id = $1 AND merchant_id = $2
    `, [req.params.id, req.merchantId]);

    if (existing.rows.length === 0) {
      return res.status(404).json({
        error: {
          type: 'invalid_request_error',
          message: 'Customer not found',
        },
      });
    }

    // Validate email if provided
    if (email && !isValidEmail(email)) {
      return res.status(400).json({
        error: {
          type: 'invalid_request_error',
          message: 'Invalid email format',
          param: 'email',
        },
      });
    }

    // Build update query
    const updates = [];
    const params = [req.params.id];
    let paramIndex = 2;

    if (email !== undefined) {
      updates.push(`email = $${paramIndex++}`);
      params.push(email);
    }

    if (name !== undefined) {
      updates.push(`name = $${paramIndex++}`);
      params.push(name);
    }

    if (phone !== undefined) {
      updates.push(`phone = $${paramIndex++}`);
      params.push(phone);
    }

    if (metadata !== undefined) {
      updates.push(`metadata = $${paramIndex++}`);
      params.push(JSON.stringify(metadata));
    }

    if (updates.length === 0) {
      return res.json(formatCustomer(existing.rows[0]));
    }

    const result = await query(`
      UPDATE customers
      SET ${updates.join(', ')}
      WHERE id = $1
      RETURNING *
    `, params);

    res.json(formatCustomer(result.rows[0]));
  } catch (error) {
    console.error('Update customer error:', error);
    res.status(500).json({
      error: {
        type: 'api_error',
        message: 'Failed to update customer',
      },
    });
  }
});

/**
 * Delete a customer
 * DELETE /v1/customers/:id
 */
router.delete('/:id', async (req, res) => {
  try {
    const result = await query(`
      DELETE FROM customers
      WHERE id = $1 AND merchant_id = $2
      RETURNING id
    `, [req.params.id, req.merchantId]);

    if (result.rows.length === 0) {
      return res.status(404).json({
        error: {
          type: 'invalid_request_error',
          message: 'Customer not found',
        },
      });
    }

    res.json({
      id: req.params.id,
      object: 'customer',
      deleted: true,
    });
  } catch (error) {
    console.error('Delete customer error:', error);
    res.status(500).json({
      error: {
        type: 'api_error',
        message: 'Failed to delete customer',
      },
    });
  }
});

/**
 * Format customer for API response
 */
function formatCustomer(row) {
  return {
    id: row.id,
    object: 'customer',
    email: row.email,
    name: row.name,
    phone: row.phone,
    metadata: row.metadata || {},
    created: Math.floor(new Date(row.created_at).getTime() / 1000),
    livemode: false,
  };
}

export default router;
