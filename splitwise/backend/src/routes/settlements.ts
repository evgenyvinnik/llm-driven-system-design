import express, { type Request, type Response } from 'express';
import { pool } from '../db/pool.js';
import { authMiddleware, getGroupMembership, type AuthenticatedRequest } from '../middleware/auth.js';
import { idempotencyMiddleware, STATUS } from '../shared/idempotency.js';
import { invalidateGroupBalance } from '../db/redis.js';
import { settlementsTotal } from '../shared/metrics.js';
import { logger, formatAmount } from '../shared/logger.js';

const router = express.Router();

interface CreateSettlementRequest {
  groupId?: string;
  fromUserId: string;
  toUserId: string;
  amountCents: number;
  note?: string;
  method?: string;
}

// Record a settlement ("I paid you back"). Idempotent on the Idempotency-Key.
router.post('/', authMiddleware, idempotencyMiddleware('settlement'), async (req: Request<object, unknown, CreateSettlementRequest>, res: Response): Promise<void> => {
  const authReq = req as AuthenticatedRequest;
  try {
    const { groupId, fromUserId, toUserId, amountCents, note, method } = req.body;

    if (!fromUserId || !toUserId || !amountCents) {
      res.status(400).json({ error: 'fromUserId, toUserId and amountCents are required' });
      return;
    }
    if (fromUserId === toUserId) {
      res.status(400).json({ error: 'Cannot settle with yourself' });
      return;
    }
    if (!Number.isInteger(amountCents) || amountCents <= 0) {
      res.status(400).json({ error: 'amountCents must be a positive integer' });
      return;
    }
    // The person recording the settlement must be one of the two parties.
    if (authReq.user.id !== fromUserId && authReq.user.id !== toUserId) {
      res.status(403).json({ error: 'You can only record settlements you are part of' });
      return;
    }
    // Group settlements require both parties to be members.
    if (groupId) {
      const from = await getGroupMembership(groupId, fromUserId);
      const to = await getGroupMembership(groupId, toUserId);
      if (!from || !to) {
        res.status(400).json({ error: 'Both parties must be members of the group' });
        return;
      }
    }

    const sRes = await pool.query(
      `INSERT INTO settlements (group_id, from_user, to_user, amount_cents, note, method, created_by, idempotency_key)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id, created_at`,
      [groupId || null, fromUserId, toUserId, amountCents, note || null, method || 'cash', authReq.user.id, authReq.idempotencyKey || null]
    );
    const settlement = sRes.rows[0];

    if (groupId) {
      const names = await pool.query('SELECT id, name, username FROM users WHERE id = ANY($1::uuid[])', [[fromUserId, toUserId]]);
      const nameOf = (id: string) => {
        const u = names.rows.find((r) => r.id === id);
        return u?.name || u?.username || 'Someone';
      };
      await pool.query(
        `INSERT INTO activity_log (group_id, actor_id, type, settlement_id, summary)
         VALUES ($1, $2, 'settlement', $3, $4)`,
        [groupId, authReq.user.id, settlement.id, `${nameOf(fromUserId)} paid ${nameOf(toUserId)} ${formatAmount(amountCents)}`]
      );
      await invalidateGroupBalance(groupId);
    }

    settlementsTotal.inc({ method: method || 'cash' });
    logger.info({ event: 'settlement_recorded', settlementId: settlement.id, groupId, amount: amountCents });

    const response = { id: settlement.id, createdAt: settlement.created_at };
    if (authReq.storeIdempotencyResult) {
      await authReq.storeIdempotencyResult(STATUS.COMPLETED, response);
    }
    res.status(201).json(response);
  } catch (error) {
    if ((error as { code?: string }).code === '23505') {
      res.status(409).json({ error: 'Duplicate settlement (idempotency key already used)' });
      return;
    }
    console.error('Create settlement error:', error);
    if (authReq.storeIdempotencyResult) {
      await authReq.storeIdempotencyResult(STATUS.FAILED, { error: 'Failed to record settlement', statusCode: 500 });
    }
    res.status(500).json({ error: 'Failed to record settlement' });
  }
});

// List settlements for a group.
router.get('/group/:groupId', authMiddleware, async (req: Request, res: Response): Promise<void> => {
  try {
    const authReq = req as AuthenticatedRequest;
    const membership = await getGroupMembership(req.params.groupId, authReq.user.id);
    if (!membership) {
      res.status(403).json({ error: 'You are not a member of this group' });
      return;
    }
    const sRes = await pool.query(
      `SELECT s.id, s.amount_cents, s.note, s.method, s.created_at,
              s.from_user, s.to_user,
              fu.name AS from_name, fu.username AS from_username,
              tu.name AS to_name, tu.username AS to_username
       FROM settlements s
       JOIN users fu ON fu.id = s.from_user
       JOIN users tu ON tu.id = s.to_user
       WHERE s.group_id = $1 ORDER BY s.created_at DESC`,
      [req.params.groupId]
    );
    res.json(
      sRes.rows.map((s) => ({
        id: s.id,
        amountCents: Number(s.amount_cents),
        note: s.note,
        method: s.method,
        fromUser: s.from_user,
        toUser: s.to_user,
        fromName: s.from_name || s.from_username,
        toName: s.to_name || s.to_username,
        createdAt: s.created_at,
      }))
    );
  } catch (error) {
    console.error('List settlements error:', error);
    res.status(500).json({ error: 'Failed to list settlements' });
  }
});

export default router;
