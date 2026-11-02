import { Router, Request, Response } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { pool } from '../services/db.js';
import { PaymentError, sendError } from '../services/errors.js';
import { isUuid } from '../services/validation.js';

const router = Router();

/** Postgres unique_violation: here, the one-default-per-user partial index. */
const UNIQUE_VIOLATION = '23505';

function toPaymentMethod(row: Record<string, unknown>) {
  return {
    id: row.id,
    type: row.type,
    label: row.label,
    lastFour: row.last_four,
    isDefault: row.is_default,
    createdAt: row.created_at,
  };
}

function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: string })?.code === UNIQUE_VIOLATION;
}

// GET /api/payment-methods - List user's payment methods
router.get('/', requireAuth, async (req: Request, res: Response) => {
  try {
    const result = await pool.query(
      `SELECT id, type, label, last_four, is_default, created_at
       FROM payment_methods
       WHERE user_id = $1
       ORDER BY is_default DESC, created_at DESC`,
      [req.session.userId],
    );

    res.json({ paymentMethods: result.rows.map(toPaymentMethod) });
  } catch (err) {
    sendError(res, err, 'Failed to get payment methods');
  }
});

// POST /api/payment-methods - Add a payment method
router.post('/', requireAuth, async (req: Request, res: Response) => {
  try {
    const { type, label, lastFour, isDefault } = req.body ?? {};

    if (!type || !['bank', 'card'].includes(type)) {
      throw new PaymentError(400, 'INVALID_TYPE', 'Type must be "bank" or "card"');
    }
    if (typeof label !== 'string' || !label.trim() || label.trim().length > 100) {
      throw new PaymentError(400, 'INVALID_LABEL', 'Label is required (at most 100 characters)');
    }
    // VARCHAR(4) would reject anything longer with a 500.
    if (lastFour !== undefined && lastFour !== null && lastFour !== '' &&
        (typeof lastFour !== 'string' || !/^\d{4}$/.test(lastFour))) {
      throw new PaymentError(400, 'INVALID_LAST_FOUR', 'Last four must be exactly 4 digits');
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // If setting as default, unset others
      if (isDefault === true) {
        await client.query(
          'UPDATE payment_methods SET is_default = false WHERE user_id = $1',
          [req.session.userId],
        );
      }

      const result = await client.query(
        `INSERT INTO payment_methods (user_id, type, label, last_four, is_default)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, type, label, last_four, is_default, created_at`,
        [req.session.userId, type, label.trim(), lastFour || null, isDefault === true],
      );

      await client.query('COMMIT');
      res.status(201).json({ paymentMethod: toPaymentMethod(result.rows[0]) });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    if (isUniqueViolation(err)) {
      res.status(409).json({ error: 'Default payment method changed concurrently, please retry' });
      return;
    }
    sendError(res, err, 'Failed to add payment method');
  }
});

// DELETE /api/payment-methods/:id - Remove a payment method
router.delete('/:id', requireAuth, async (req: Request, res: Response) => {
  try {
    const result = isUuid(req.params.id)
      ? await pool.query(
          'DELETE FROM payment_methods WHERE id = $1 AND user_id = $2 RETURNING id',
          [req.params.id, req.session.userId],
        )
      : { rows: [] };

    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Payment method not found' });
      return;
    }

    res.json({ message: 'Payment method removed' });
  } catch (err) {
    sendError(res, err, 'Failed to delete payment method');
  }
});

// PUT /api/payment-methods/:id/default - Set as default
router.put('/:id/default', requireAuth, async (req: Request, res: Response) => {
  if (!isUuid(req.params.id)) {
    res.status(404).json({ error: 'Payment method not found' });
    return;
  }
  try {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Verify ownership
      const check = await client.query(
        'SELECT id FROM payment_methods WHERE id = $1 AND user_id = $2',
        [req.params.id, req.session.userId],
      );

      if (check.rows.length === 0) {
        await client.query('ROLLBACK');
        res.status(404).json({ error: 'Payment method not found' });
        return;
      }

      // Unset all defaults
      await client.query(
        'UPDATE payment_methods SET is_default = false WHERE user_id = $1',
        [req.session.userId],
      );

      // Set new default
      await client.query(
        'UPDATE payment_methods SET is_default = true WHERE id = $1 AND user_id = $2',
        [req.params.id, req.session.userId],
      );

      await client.query('COMMIT');
      res.json({ message: 'Default payment method updated' });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    if (isUniqueViolation(err)) {
      res.status(409).json({ error: 'Default payment method changed concurrently, please retry' });
      return;
    }
    sendError(res, err, 'Failed to set default payment method');
  }
});

/** Payment methods router for CRUD operations and default management. */
export default router;
