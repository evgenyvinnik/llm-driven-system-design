import express, { type Request, type Response } from 'express';
import { pool } from '../db/pool.js';
import { authMiddleware, getGroupMembership, type AuthenticatedRequest } from '../middleware/auth.js';

const router = express.Router();

// Recent activity across all of the current user's groups (the global feed).
router.get('/', authMiddleware, async (req: Request, res: Response): Promise<void> => {
  try {
    const authReq = req as AuthenticatedRequest;
    const limit = Math.min(parseInt(String(req.query.limit || '30')), 100);

    const rows = await pool.query(
      `SELECT a.id, a.type, a.summary, a.created_at, a.group_id, a.expense_id,
              g.name AS group_name, g.avatar_color,
              u.name AS actor_name, u.username AS actor_username, u.avatar_url AS actor_avatar
       FROM activity_log a
       JOIN groups g ON g.id = a.group_id
       JOIN group_members gm ON gm.group_id = a.group_id AND gm.user_id = $1
       LEFT JOIN users u ON u.id = a.actor_id
       ORDER BY a.created_at DESC LIMIT $2`,
      [authReq.user.id, limit]
    );

    res.json(
      rows.rows.map((a) => ({
        id: String(a.id),
        type: a.type,
        summary: a.summary,
        groupId: a.group_id,
        groupName: a.group_name,
        avatarColor: a.avatar_color,
        expenseId: a.expense_id,
        actorName: a.actor_name || a.actor_username,
        actorAvatar: a.actor_avatar,
        createdAt: a.created_at,
      }))
    );
  } catch (error) {
    console.error('Get activity error:', error);
    res.status(500).json({ error: 'Failed to get activity' });
  }
});

// Activity for a single group.
router.get('/group/:groupId', authMiddleware, async (req: Request, res: Response): Promise<void> => {
  try {
    const authReq = req as AuthenticatedRequest;
    const membership = await getGroupMembership(req.params.groupId, authReq.user.id);
    if (!membership) {
      res.status(403).json({ error: 'You are not a member of this group' });
      return;
    }
    const rows = await pool.query(
      `SELECT a.id, a.type, a.summary, a.created_at, a.expense_id,
              u.name AS actor_name, u.username AS actor_username, u.avatar_url AS actor_avatar
       FROM activity_log a
       LEFT JOIN users u ON u.id = a.actor_id
       WHERE a.group_id = $1 ORDER BY a.created_at DESC LIMIT 50`,
      [req.params.groupId]
    );
    res.json(
      rows.rows.map((a) => ({
        id: String(a.id),
        type: a.type,
        summary: a.summary,
        expenseId: a.expense_id,
        actorName: a.actor_name || a.actor_username,
        actorAvatar: a.actor_avatar,
        createdAt: a.created_at,
      }))
    );
  } catch (error) {
    console.error('Get group activity error:', error);
    res.status(500).json({ error: 'Failed to get group activity' });
  }
});

export default router;
