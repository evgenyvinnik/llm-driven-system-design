import { Router, Request, Response } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { executeTransfer } from '../services/transferService.js';
import { moneyLimiter } from '../services/rateLimiter.js';
import { pool } from '../services/db.js';
import { PaymentError, sendError } from '../services/errors.js';
import {
  MAX_TRANSFER_CENTS,
  isUuid,
  parseAmountCents,
  parseIdempotencyKey,
  parseIntParam,
  parseNote,
} from '../services/validation.js';

const router = Router();

// POST /api/transfers - Send money (P2P transfer with idempotency)
router.post('/', requireAuth, moneyLimiter, async (req: Request, res: Response) => {
  try {
    const { recipientId } = req.body ?? {};
    if (!recipientId) {
      throw new PaymentError(400, 'RECIPIENT_REQUIRED', 'Recipient is required');
    }
    if (!isUuid(recipientId)) {
      // Malformed IDs would otherwise surface as a Postgres cast error (500).
      throw new PaymentError(404, 'RECIPIENT_NOT_FOUND', 'Recipient not found');
    }

    const { result, replayed } = await executeTransfer({
      senderId: req.session.userId!,
      recipientId,
      amountCents: parseAmountCents(req.body.amountCents, MAX_TRANSFER_CENTS),
      note: parseNote(req.body.note),
      idempotencyKey: parseIdempotencyKey(req),
    });

    if (replayed) res.set('Idempotent-Replayed', 'true');
    res.json(result);
  } catch (err) {
    sendError(res, err, 'Transfer failed');
  }
});

// GET /api/transfers - Get the caller's transaction history
router.get('/', requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = req.session.userId!;
    const { type } = req.query;
    const limit = parseIntParam(req.query.limit, 50, 1, 100);
    const offset = parseIntParam(req.query.offset, 0, 0, 1_000_000);

    let query = `
      SELECT t.id, t.sender_id, t.recipient_id, t.amount_cents, t.currency,
             t.type, t.status, t.note, t.payment_method_id, t.created_at,
             su.username as sender_username, su.display_name as sender_display_name,
             ru.username as recipient_username, ru.display_name as recipient_display_name
      FROM transactions t
      LEFT JOIN users su ON t.sender_id = su.id
      LEFT JOIN users ru ON t.recipient_id = ru.id
      WHERE (t.sender_id = $1 OR t.recipient_id = $1)
    `;

    const params: (string | number)[] = [userId];
    let paramIndex = 2;

    if (type && typeof type === 'string' && ['transfer', 'deposit', 'withdrawal'].includes(type)) {
      query += ` AND t.type = $${paramIndex}`;
      params.push(type);
      paramIndex++;
    }

    // id breaks ties so pagination is stable when rows share a timestamp.
    query += ` ORDER BY t.created_at DESC, t.id DESC LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
    params.push(limit, offset);

    const result = await pool.query(query, params);

    const transactions = result.rows.map((row) => ({
      id: row.id,
      senderId: row.sender_id,
      recipientId: row.recipient_id,
      amountCents: Number(row.amount_cents),
      currency: row.currency,
      type: row.type,
      status: row.status,
      note: row.note,
      paymentMethodId: row.payment_method_id,
      createdAt: row.created_at,
      senderUsername: row.sender_username,
      senderDisplayName: row.sender_display_name,
      recipientUsername: row.recipient_username,
      recipientDisplayName: row.recipient_display_name,
    }));

    res.json({ transactions });
  } catch (err) {
    sendError(res, err, 'Failed to get transactions');
  }
});

/** Transfers router for P2P money sends with idempotency and transaction history. */
export default router;
