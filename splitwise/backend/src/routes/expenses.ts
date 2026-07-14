import express, { type Request, type Response } from 'express';
import { pool, transaction } from '../db/pool.js';
import { authMiddleware, getGroupMembership, type AuthenticatedRequest } from '../middleware/auth.js';
import { idempotencyMiddleware, STATUS } from '../shared/idempotency.js';
import { invalidateGroupBalance } from '../db/redis.js';
import { calculateSplits, SplitError, type SplitType, type ParticipantInput } from '../services/splits.js';
import { expensesTotal, expenseAmountHistogram } from '../shared/metrics.js';
import { logger, formatAmount } from '../shared/logger.js';

const router = express.Router();

interface CreateExpenseRequest {
  groupId: string;
  description: string;
  amountCents: number;
  paidBy: string;
  splitType: SplitType;
  category?: string;
  note?: string;
  participants: ParticipantInput[];
}

// List a group's expenses (most recent first).
router.get('/group/:groupId', authMiddleware, async (req: Request, res: Response): Promise<void> => {
  try {
    const authReq = req as AuthenticatedRequest;
    const membership = await getGroupMembership(req.params.groupId, authReq.user.id);
    if (!membership) {
      res.status(403).json({ error: 'You are not a member of this group' });
      return;
    }

    const limit = Math.min(parseInt(String(req.query.limit || '50')), 100);
    const offset = parseInt(String(req.query.offset || '0'));

    const expensesRes = await pool.query(
      `SELECT e.id, e.description, e.amount_cents, e.category, e.split_type, e.note,
              e.paid_by, e.created_at, u.name AS payer_name, u.username AS payer_username,
              u.avatar_url AS payer_avatar,
              ps.owed_cents AS my_owed
       FROM expenses e
       JOIN users u ON u.id = e.paid_by
       LEFT JOIN expense_splits ps ON ps.expense_id = e.id AND ps.user_id = $2
       WHERE e.group_id = $1 AND e.deleted_at IS NULL
       ORDER BY e.created_at DESC LIMIT $3 OFFSET $4`,
      [req.params.groupId, authReq.user.id, limit, offset]
    );

    res.json(
      expensesRes.rows.map((e) => {
        const myOwed = e.my_owed == null ? 0 : Number(e.my_owed);
        const iPaid = e.paid_by === authReq.user.id;
        // My net for this expense: what I paid (if payer) minus what I owe.
        const myNet = (iPaid ? Number(e.amount_cents) : 0) - myOwed;
        return {
          id: e.id,
          description: e.description,
          amountCents: Number(e.amount_cents),
          category: e.category,
          splitType: e.split_type,
          note: e.note,
          paidBy: e.paid_by,
          payerName: e.payer_name,
          payerUsername: e.payer_username,
          payerAvatar: e.payer_avatar,
          iPaid,
          myNetCents: myNet, // + = I'm owed for this, - = I owe for this
          createdAt: e.created_at,
        };
      })
    );
  } catch (error) {
    console.error('List expenses error:', error);
    res.status(500).json({ error: 'Failed to list expenses' });
  }
});

// Create an expense with its splits. Idempotent on the Idempotency-Key header.
router.post('/', authMiddleware, idempotencyMiddleware('expense'), async (req: Request<object, unknown, CreateExpenseRequest>, res: Response): Promise<void> => {
  const authReq = req as AuthenticatedRequest;
  try {
    const { groupId, description, amountCents, paidBy, splitType, category, note, participants } = req.body;

    if (!groupId || !description || !amountCents || !paidBy || !splitType || !participants) {
      res.status(400).json({ error: 'Missing required fields' });
      return;
    }

    const membership = await getGroupMembership(groupId, authReq.user.id);
    if (!membership) {
      res.status(403).json({ error: 'You are not a member of this group' });
      return;
    }

    // Payer and all participants must be members of the group.
    const memberRows = await pool.query<{ user_id: string }>(
      'SELECT user_id FROM group_members WHERE group_id = $1',
      [groupId]
    );
    const memberSet = new Set(memberRows.rows.map((r) => r.user_id));
    if (!memberSet.has(paidBy)) {
      res.status(400).json({ error: 'Payer must be a member of the group' });
      return;
    }
    for (const p of participants) {
      if (!memberSet.has(p.userId)) {
        res.status(400).json({ error: 'All participants must be members of the group' });
        return;
      }
    }

    // Resolve the split. Any inconsistency (bad sums, etc.) is a 400.
    let splits;
    try {
      splits = calculateSplits(amountCents, splitType, participants);
    } catch (err) {
      if (err instanceof SplitError) {
        res.status(400).json({ error: err.message });
        return;
      }
      throw err;
    }

    const expense = await transaction(async (client) => {
      const eRes = await client.query(
        `INSERT INTO expenses (group_id, description, amount_cents, category, paid_by, split_type, note, created_by, idempotency_key)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id, created_at`,
        [groupId, description, amountCents, category || 'general', paidBy, splitType, note || null, authReq.user.id, authReq.idempotencyKey || null]
      );
      const e = eRes.rows[0];

      for (const s of splits) {
        await client.query(
          `INSERT INTO expense_splits (expense_id, user_id, owed_cents, share_units, percentage)
           VALUES ($1, $2, $3, $4, $5)`,
          [e.id, s.userId, s.owedCents, s.shareUnits, s.percentage]
        );
      }

      const payerName = (await client.query('SELECT name, username FROM users WHERE id = $1', [paidBy])).rows[0];
      await client.query(
        `INSERT INTO activity_log (group_id, actor_id, type, expense_id, summary)
         VALUES ($1, $2, 'expense_added', $3, $4)`,
        [groupId, authReq.user.id, e.id, `${payerName?.name || payerName?.username} paid ${formatAmount(amountCents)} for "${description}"`]
      );

      return e;
    });

    await invalidateGroupBalance(groupId);
    expensesTotal.inc({ split_type: splitType });
    expenseAmountHistogram.observe(amountCents);
    logger.info({ event: 'expense_created', expenseId: expense.id, groupId, amount: amountCents, userId: authReq.user.id });

    const response = { id: expense.id, createdAt: expense.created_at };
    if (authReq.storeIdempotencyResult) {
      await authReq.storeIdempotencyResult(STATUS.COMPLETED, response);
    }
    res.status(201).json(response);
  } catch (error) {
    // A concurrent duplicate that raced past Redis is caught by the unique index.
    if ((error as { code?: string }).code === '23505') {
      res.status(409).json({ error: 'Duplicate expense (idempotency key already used)' });
      return;
    }
    console.error('Create expense error:', error);
    if (authReq.storeIdempotencyResult) {
      await authReq.storeIdempotencyResult(STATUS.FAILED, { error: 'Failed to create expense', statusCode: 500 });
    }
    res.status(500).json({ error: 'Failed to create expense' });
  }
});

// Expense detail: splits (with member info) + comments.
router.get('/:id', authMiddleware, async (req: Request, res: Response): Promise<void> => {
  try {
    const authReq = req as AuthenticatedRequest;
    const eRes = await pool.query(
      `SELECT e.*, u.name AS payer_name, u.username AS payer_username, u.avatar_url AS payer_avatar
       FROM expenses e JOIN users u ON u.id = e.paid_by
       WHERE e.id = $1 AND e.deleted_at IS NULL`,
      [req.params.id]
    );
    if (eRes.rows.length === 0) {
      res.status(404).json({ error: 'Expense not found' });
      return;
    }
    const e = eRes.rows[0];

    const membership = await getGroupMembership(e.group_id, authReq.user.id);
    if (!membership) {
      res.status(403).json({ error: 'You are not a member of this group' });
      return;
    }

    const splitsRes = await pool.query(
      `SELECT s.user_id, s.owed_cents, s.share_units, s.percentage, u.name, u.username, u.avatar_url
       FROM expense_splits s JOIN users u ON u.id = s.user_id
       WHERE s.expense_id = $1`,
      [req.params.id]
    );

    const commentsRes = await pool.query(
      `SELECT c.id, c.content, c.created_at, u.name, u.username, u.avatar_url
       FROM expense_comments c JOIN users u ON u.id = c.user_id
       WHERE c.expense_id = $1 ORDER BY c.created_at`,
      [req.params.id]
    );

    res.json({
      id: e.id,
      groupId: e.group_id,
      description: e.description,
      amountCents: Number(e.amount_cents),
      category: e.category,
      splitType: e.split_type,
      note: e.note,
      paidBy: e.paid_by,
      payerName: e.payer_name,
      payerUsername: e.payer_username,
      payerAvatar: e.payer_avatar,
      createdAt: e.created_at,
      splits: splitsRes.rows.map((s) => ({
        userId: s.user_id,
        name: s.name,
        username: s.username,
        avatarUrl: s.avatar_url,
        owedCents: Number(s.owed_cents),
        shareUnits: s.share_units,
        percentage: s.percentage == null ? null : Number(s.percentage),
      })),
      comments: commentsRes.rows.map((c) => ({
        id: c.id,
        content: c.content,
        name: c.name,
        username: c.username,
        avatarUrl: c.avatar_url,
        createdAt: c.created_at,
      })),
    });
  } catch (error) {
    console.error('Get expense error:', error);
    res.status(500).json({ error: 'Failed to get expense' });
  }
});

// Soft-delete an expense (keeps history/audit; balances recompute without it).
router.delete('/:id', authMiddleware, async (req: Request, res: Response): Promise<void> => {
  try {
    const authReq = req as AuthenticatedRequest;
    const eRes = await pool.query('SELECT group_id, description FROM expenses WHERE id = $1 AND deleted_at IS NULL', [req.params.id]);
    if (eRes.rows.length === 0) {
      res.status(404).json({ error: 'Expense not found' });
      return;
    }
    const { group_id, description } = eRes.rows[0];

    const membership = await getGroupMembership(group_id, authReq.user.id);
    if (!membership) {
      res.status(403).json({ error: 'You are not a member of this group' });
      return;
    }

    await pool.query('UPDATE expenses SET deleted_at = NOW() WHERE id = $1', [req.params.id]);
    await pool.query(
      `INSERT INTO activity_log (group_id, actor_id, type, summary) VALUES ($1, $2, 'expense_deleted', $3)`,
      [group_id, authReq.user.id, `${authReq.user.name || authReq.user.username} deleted "${description}"`]
    );
    await invalidateGroupBalance(group_id);

    res.json({ message: 'Expense deleted' });
  } catch (error) {
    console.error('Delete expense error:', error);
    res.status(500).json({ error: 'Failed to delete expense' });
  }
});

// Add a comment to an expense.
router.post('/:id/comments', authMiddleware, async (req: Request<{ id: string }, unknown, { content: string }>, res: Response): Promise<void> => {
  try {
    const authReq = req as unknown as AuthenticatedRequest;
    const { content } = req.body;
    if (!content || content.trim().length === 0) {
      res.status(400).json({ error: 'Comment content is required' });
      return;
    }

    const eRes = await pool.query('SELECT group_id FROM expenses WHERE id = $1 AND deleted_at IS NULL', [req.params.id]);
    if (eRes.rows.length === 0) {
      res.status(404).json({ error: 'Expense not found' });
      return;
    }
    const membership = await getGroupMembership(eRes.rows[0].group_id, authReq.user.id);
    if (!membership) {
      res.status(403).json({ error: 'You are not a member of this group' });
      return;
    }

    const cRes = await pool.query(
      `INSERT INTO expense_comments (expense_id, user_id, content) VALUES ($1, $2, $3) RETURNING id, created_at`,
      [req.params.id, authReq.user.id, content.trim()]
    );
    res.status(201).json({
      id: cRes.rows[0].id,
      content: content.trim(),
      name: authReq.user.name,
      username: authReq.user.username,
      avatarUrl: authReq.user.avatar_url,
      createdAt: cRes.rows[0].created_at,
    });
  } catch (error) {
    console.error('Add comment error:', error);
    res.status(500).json({ error: 'Failed to add comment' });
  }
});

export default router;
