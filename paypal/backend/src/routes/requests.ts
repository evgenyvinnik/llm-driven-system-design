import { Router, Request, Response } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { transferWithinTransaction } from '../services/transferService.js';
import { moneyLimiter } from '../services/rateLimiter.js';
import { pool } from '../services/db.js';
import { logger } from '../services/logger.js';
import { transferTotal, walletOperations } from '../services/metrics.js';
import { PaymentError, sendError } from '../services/errors.js';
import { MAX_TRANSFER_CENTS, isUuid, parseAmountCents, parseNote } from '../services/validation.js';

const router = Router();

// POST /api/requests - Request money from another user
router.post('/', requireAuth, async (req: Request, res: Response) => {
  try {
    const { payerId } = req.body ?? {};

    if (!payerId) {
      throw new PaymentError(400, 'PAYER_REQUIRED', 'Payer is required');
    }
    // Same cap as a transfer: paying the request is a transfer.
    const amountCents = parseAmountCents(req.body.amountCents, MAX_TRANSFER_CENTS);
    const note = parseNote(req.body.note);

    if (payerId === req.session.userId) {
      throw new PaymentError(400, 'SELF_REQUEST', 'Cannot request money from yourself');
    }

    // Only real customers can be asked to pay; an unknown ID used to fail the
    // foreign key and come back as a 500.
    const payer = isUuid(payerId)
      ? await pool.query(`SELECT id FROM users WHERE id = $1 AND role <> 'system'`, [payerId])
      : { rows: [] };
    if (payer.rows.length === 0) {
      throw new PaymentError(404, 'USER_NOT_FOUND', 'User not found');
    }

    const result = await pool.query(
      `INSERT INTO transfer_requests (requester_id, payer_id, amount_cents, note)
       VALUES ($1, $2, $3, $4)
       RETURNING id, requester_id, payer_id, amount_cents, currency, note, status, created_at, updated_at`,
      [req.session.userId, payerId, amountCents, note],
    );

    const request = result.rows[0];

    res.status(201).json({
      request: {
        id: request.id,
        requesterId: request.requester_id,
        payerId: request.payer_id,
        amountCents: Number(request.amount_cents),
        currency: request.currency,
        note: request.note,
        status: request.status,
        transactionId: null,
        createdAt: request.created_at,
        updatedAt: request.updated_at,
      },
    });
  } catch (err) {
    sendError(res, err, 'Failed to create request');
  }
});

// GET /api/requests - Get incoming and outgoing requests
router.get('/', requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = req.session.userId!;
    const { direction = 'all', status } = req.query;

    let query = `
      SELECT r.id, r.requester_id, r.payer_id, r.amount_cents, r.currency,
             r.note, r.status, r.transaction_id, r.created_at, r.updated_at,
             req.username as requester_username, req.display_name as requester_display_name,
             pay.username as payer_username, pay.display_name as payer_display_name
      FROM transfer_requests r
      JOIN users req ON r.requester_id = req.id
      JOIN users pay ON r.payer_id = pay.id
      WHERE 1=1
    `;

    const params: (string | number)[] = [];
    let paramIndex = 1;

    if (direction === 'incoming') {
      query += ` AND r.payer_id = $${paramIndex}`;
      params.push(userId);
      paramIndex++;
    } else if (direction === 'outgoing') {
      query += ` AND r.requester_id = $${paramIndex}`;
      params.push(userId);
      paramIndex++;
    } else {
      query += ` AND (r.requester_id = $${paramIndex} OR r.payer_id = $${paramIndex})`;
      params.push(userId);
      paramIndex++;
    }

    if (status && typeof status === 'string' && ['pending', 'paid', 'declined', 'cancelled'].includes(status)) {
      query += ` AND r.status = $${paramIndex}`;
      params.push(status);
      paramIndex++;
    }

    query += ' ORDER BY r.created_at DESC LIMIT 50';

    const result = await pool.query(query, params);

    const requests = result.rows.map((row) => ({
      id: row.id,
      requesterId: row.requester_id,
      payerId: row.payer_id,
      amountCents: Number(row.amount_cents),
      currency: row.currency,
      note: row.note,
      status: row.status,
      transactionId: row.transaction_id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      requesterUsername: row.requester_username,
      requesterDisplayName: row.requester_display_name,
      payerUsername: row.payer_username,
      payerDisplayName: row.payer_display_name,
    }));

    res.json({ requests });
  } catch (err) {
    sendError(res, err, 'Failed to get requests');
  }
});

type RequestAction = 'pay' | 'decline' | 'cancel';

/**
 * Locks the request row and checks the caller may act on it. Everything after
 * this runs in the same transaction, so two clicks on Pay (or Pay racing
 * Decline) serialize on the row lock and the second one sees the new status.
 *
 * Parties who are neither payer nor requester get 404, the same as a request
 * that doesn't exist, so request IDs reveal nothing to outsiders.
 */
async function lockRequestForAction(
  client: import('pg').PoolClient,
  id: string,
  userId: string,
  action: RequestAction,
) {
  const result = isUuid(id)
    ? await client.query(
        `SELECT id, requester_id, payer_id, amount_cents, status, note
         FROM transfer_requests WHERE id = $1 FOR UPDATE`,
        [id],
      )
    : { rows: [] };
  const request = result.rows[0];

  if (!request || (request.payer_id !== userId && request.requester_id !== userId)) {
    throw new PaymentError(404, 'REQUEST_NOT_FOUND', 'Request not found');
  }

  // Only the payer pays or declines; only the requester cancels.
  const allowed = action === 'cancel' ? request.requester_id === userId : request.payer_id === userId;
  if (!allowed) {
    const who = action === 'cancel' ? 'requester' : 'payer';
    throw new PaymentError(403, 'NOT_ALLOWED', `Only the ${who} can ${action} this request`);
  }

  if (request.status !== 'pending') {
    throw new PaymentError(409, 'REQUEST_NOT_PENDING', `Request is already ${request.status}`);
  }

  return request;
}

// POST /api/requests/:id/pay - Pay a transfer request
router.post('/:id/pay', requireAuth, moneyLimiter, async (req: Request, res: Response) => {
  const userId = req.session.userId!;
  // Express 4 doesn't catch rejected promises, so even connect() stays inside try.
  let client: import('pg').PoolClient | undefined;
  try {
    client = await pool.connect();
    await client.query('BEGIN');

    // Lock order: request row, then wallets (inside the transfer). Decline and
    // cancel take only the request row, so the orders can't form a cycle.
    const request = await lockRequestForAction(client, req.params.id, userId, 'pay');

    const transfer = await transferWithinTransaction(
      client,
      userId,
      request.requester_id,
      Number(request.amount_cents),
      request.note || 'Payment for request',
      null,
    );

    await client.query(
      `UPDATE transfer_requests SET status = 'paid', transaction_id = $2, updated_at = NOW()
       WHERE id = $1`,
      [request.id, transfer.transaction.id],
    );

    await client.query('COMMIT');
    transferTotal.inc({ status: 'completed' });
    walletOperations.inc({ type: 'transfer' });
    logger.info({ requestId: request.id, transactionId: transfer.transaction.id }, 'Request paid');

    res.json({
      request: { id: request.id, status: 'paid', transactionId: transfer.transaction.id },
      transaction: transfer.transaction,
      senderBalance: transfer.senderBalance,
    });
  } catch (err) {
    await client?.query('ROLLBACK').catch(() => undefined);
    sendError(res, err, 'Failed to pay request');
  } finally {
    client?.release();
  }
});

/** Decline (payer) and cancel (requester) differ only in who may do it and the end state. */
function closeRequestHandler(action: 'decline' | 'cancel') {
  const newStatus = action === 'decline' ? 'declined' : 'cancelled';
  return async (req: Request, res: Response) => {
    let client: import('pg').PoolClient | undefined;
    try {
      client = await pool.connect();
      await client.query('BEGIN');
      const request = await lockRequestForAction(client, req.params.id, req.session.userId!, action);
      await client.query(
        `UPDATE transfer_requests SET status = $1, updated_at = NOW() WHERE id = $2`,
        [newStatus, request.id],
      );
      await client.query('COMMIT');
      res.json({ request: { id: request.id, status: newStatus } });
    } catch (err) {
      await client?.query('ROLLBACK').catch(() => undefined);
      sendError(res, err, `Failed to ${action} request`);
    } finally {
      client?.release();
    }
  };
}

// POST /api/requests/:id/decline - Payer declines a request
router.post('/:id/decline', requireAuth, closeRequestHandler('decline'));

// POST /api/requests/:id/cancel - Requester withdraws their own request
router.post('/:id/cancel', requireAuth, closeRequestHandler('cancel'));

/** Transfer requests router for creating, paying, declining, and cancelling money requests. */
export default router;
