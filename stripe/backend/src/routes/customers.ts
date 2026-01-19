import { Router, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { query } from '../db/pool.js';
import { authenticateApiKey, AuthenticatedRequest } from '../middleware/auth.js';
import { isValidEmail } from '../utils/helpers.js';

const router = Router();

// Interfaces
interface CustomerRow {
  id: string;
  merchant_id: string;
  email: string | null;
  name: string | null;
  phone: string | null;
  metadata: Record<string, unknown> | null;
  created_at: Date;
}

interface CustomerResponse {
  id: string;
  object: 'customer';
  email: string | null;
  name: string | null;
  phone: string | null;
  metadata: Record<string, unknown>;
  created: number;
  livemode: boolean;
}

// All routes require authentication
router.use(authenticateApiKey);

/**
 * Create a customer
 * POST /v1/customers
 */
router.post('/', async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const { email, name, phone, metadata = {} } = req.body as {
      email?: string;
      name?: string;
      phone?: string;
      metadata?: Record<string, unknown>;
    };

    // Validate email if provided
    if (email && !isValidEmail(email)) {
      res.status(400).json({
        error: {
          type: 'invalid_request_error',
          message: 'Invalid email format',
          param: 'email',
        },
      });
      return;
    }

    const id = uuidv4();

    const result = await query<CustomerRow>(
      `
      INSERT INTO customers (id, merchant_id, email, name, phone, metadata)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING *
    `,
      [id, req.merchantId, email || null, name || null, phone || null, JSON.stringify(metadata)]
    );

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
router.get('/:id', async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const result = await query<CustomerRow>(
      `
      SELECT * FROM customers
      WHERE id = $1 AND merchant_id = $2
    `,
      [req.params.id, req.merchantId]
    );

    if (result.rows.length === 0) {
      res.status(404).json({
        error: {
          type: 'invalid_request_error',
          message: 'Customer not found',
        },
      });
      return;
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
router.get('/', async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const { limit = '10', offset = '0', email } = req.query as {
      limit?: string;
      offset?: string;
      email?: string;
    };

    let queryText = `
      SELECT * FROM customers
      WHERE merchant_id = $1
    `;
    const params: unknown[] = [req.merchantId];
    let paramIndex = 2;

    if (email) {
      queryText += ` AND email = $${paramIndex}`;
      params.push(email);
      paramIndex++;
    }

    queryText += ` ORDER BY created_at DESC LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
    params.push(parseInt(limit), parseInt(offset));

    const result = await query<CustomerRow>(queryText, params);

    // Get total count
    const countResult = await query<{ count: string }>(
      `
      SELECT COUNT(*) FROM customers WHERE merchant_id = $1
    `,
      [req.merchantId]
    );

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
router.post('/:id', async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const { email, name, phone, metadata } = req.body as {
      email?: string;
      name?: string;
      phone?: string;
      metadata?: Record<string, unknown>;
    };

    // Get existing customer
    const existing = await query<CustomerRow>(
      `
      SELECT * FROM customers
      WHERE id = $1 AND merchant_id = $2
    `,
      [req.params.id, req.merchantId]
    );

    if (existing.rows.length === 0) {
      res.status(404).json({
        error: {
          type: 'invalid_request_error',
          message: 'Customer not found',
        },
      });
      return;
    }

    // Validate email if provided
    if (email && !isValidEmail(email)) {
      res.status(400).json({
        error: {
          type: 'invalid_request_error',
          message: 'Invalid email format',
          param: 'email',
        },
      });
      return;
    }

    // Build update query
    const updates: string[] = [];
    const params: unknown[] = [req.params.id];
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
      res.json(formatCustomer(existing.rows[0]));
      return;
    }

    const result = await query<CustomerRow>(
      `
      UPDATE customers
      SET ${updates.join(', ')}
      WHERE id = $1
      RETURNING *
    `,
      params
    );

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
router.delete('/:id', async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const result = await query<{ id: string }>(
      `
      DELETE FROM customers
      WHERE id = $1 AND merchant_id = $2
      RETURNING id
    `,
      [req.params.id, req.merchantId]
    );

    if (result.rows.length === 0) {
      res.status(404).json({
        error: {
          type: 'invalid_request_error',
          message: 'Customer not found',
        },
      });
      return;
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
function formatCustomer(row: CustomerRow): CustomerResponse {
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
