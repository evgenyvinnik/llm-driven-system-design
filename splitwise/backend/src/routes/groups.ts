import express, { type Request, type Response } from 'express';
import { pool, transaction } from '../db/pool.js';
import { authMiddleware, getGroupMembership, type AuthenticatedRequest } from '../middleware/auth.js';
import { computeGroupBalances, computeMyGroupBalances } from '../services/balances.js';
import { logger } from '../shared/logger.js';

const router = express.Router();

interface CreateGroupRequest {
  name: string;
  description?: string;
  groupType?: string;
  avatarColor?: string;
  memberIds?: string[];
}

// List groups the current user belongs to, badged with their net balance.
router.get('/', authMiddleware, async (req: Request, res: Response): Promise<void> => {
  try {
    const authReq = req as AuthenticatedRequest;
    const groupsRes = await pool.query(
      `SELECT g.id, g.name, g.description, g.group_type, g.avatar_color, g.created_at,
              (SELECT COUNT(*) FROM group_members gm2 WHERE gm2.group_id = g.id) AS member_count
       FROM groups g
       JOIN group_members gm ON gm.group_id = g.id
       WHERE gm.user_id = $1
       ORDER BY g.created_at DESC`,
      [authReq.user.id]
    );

    const myBalances = await computeMyGroupBalances(authReq.user.id);

    res.json(
      groupsRes.rows.map((g) => ({
        id: g.id,
        name: g.name,
        description: g.description,
        groupType: g.group_type,
        avatarColor: g.avatar_color,
        memberCount: Number(g.member_count),
        myBalanceCents: myBalances.get(g.id) || 0,
        createdAt: g.created_at,
      }))
    );
  } catch (error) {
    console.error('List groups error:', error);
    res.status(500).json({ error: 'Failed to list groups' });
  }
});

// Create a group. The creator is added as admin; any memberIds are added too.
router.post('/', authMiddleware, async (req: Request<object, unknown, CreateGroupRequest>, res: Response): Promise<void> => {
  try {
    const authReq = req as AuthenticatedRequest;
    const { name, description, groupType, avatarColor, memberIds = [] } = req.body;

    if (!name || name.trim().length === 0) {
      res.status(400).json({ error: 'Group name is required' });
      return;
    }

    const group = await transaction(async (client) => {
      const gRes = await client.query(
        `INSERT INTO groups (name, description, group_type, avatar_color, created_by)
         VALUES ($1, $2, $3, $4, $5) RETURNING *`,
        [name.trim(), description || null, groupType || 'other', avatarColor || 'green', authReq.user.id]
      );
      const g = gRes.rows[0];

      // Dedup members and always include the creator (as admin).
      const uniqueMembers = new Set(memberIds.filter((id) => id !== authReq.user.id));
      await client.query(
        `INSERT INTO group_members (group_id, user_id, role) VALUES ($1, $2, 'admin')`,
        [g.id, authReq.user.id]
      );
      for (const memberId of uniqueMembers) {
        await client.query(
          `INSERT INTO group_members (group_id, user_id, role) VALUES ($1, $2, 'member')
           ON CONFLICT DO NOTHING`,
          [g.id, memberId]
        );
      }

      await client.query(
        `INSERT INTO activity_log (group_id, actor_id, type, summary)
         VALUES ($1, $2, 'group_created', $3)`,
        [g.id, authReq.user.id, `${authReq.user.name || authReq.user.username} created the group "${g.name}"`]
      );

      return g;
    });

    logger.info({ event: 'group_created', groupId: group.id, userId: authReq.user.id });
    res.status(201).json({ id: group.id, name: group.name });
  } catch (error) {
    console.error('Create group error:', error);
    res.status(500).json({ error: 'Failed to create group' });
  }
});

// Group detail: metadata + members. 403 for non-members.
router.get('/:id', authMiddleware, async (req: Request, res: Response): Promise<void> => {
  try {
    const authReq = req as AuthenticatedRequest;
    const membership = await getGroupMembership(req.params.id, authReq.user.id);
    if (!membership) {
      res.status(403).json({ error: 'You are not a member of this group' });
      return;
    }

    const gRes = await pool.query('SELECT * FROM groups WHERE id = $1', [req.params.id]);
    if (gRes.rows.length === 0) {
      res.status(404).json({ error: 'Group not found' });
      return;
    }
    const g = gRes.rows[0];

    const membersRes = await pool.query(
      `SELECT u.id, u.username, u.name, u.avatar_url, gm.role, gm.joined_at
       FROM group_members gm JOIN users u ON u.id = gm.user_id
       WHERE gm.group_id = $1 ORDER BY gm.joined_at`,
      [req.params.id]
    );

    res.json({
      id: g.id,
      name: g.name,
      description: g.description,
      groupType: g.group_type,
      avatarColor: g.avatar_color,
      createdBy: g.created_by,
      createdAt: g.created_at,
      myRole: membership.role,
      members: membersRes.rows.map((m) => ({
        id: m.id,
        username: m.username,
        name: m.name,
        avatarUrl: m.avatar_url,
        role: m.role,
        joinedAt: m.joined_at,
      })),
    });
  } catch (error) {
    console.error('Get group error:', error);
    res.status(500).json({ error: 'Failed to get group' });
  }
});

// Add a member to a group.
router.post('/:id/members', authMiddleware, async (req: Request<{ id: string }, unknown, { userId: string }>, res: Response): Promise<void> => {
  try {
    const authReq = req as unknown as AuthenticatedRequest;
    const membership = await getGroupMembership(req.params.id, authReq.user.id);
    if (!membership) {
      res.status(403).json({ error: 'You are not a member of this group' });
      return;
    }
    const { userId } = req.body;
    if (!userId) {
      res.status(400).json({ error: 'userId is required' });
      return;
    }

    const userRes = await pool.query('SELECT id, name, username FROM users WHERE id = $1', [userId]);
    if (userRes.rows.length === 0) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    await pool.query(
      `INSERT INTO group_members (group_id, user_id, role) VALUES ($1, $2, 'member') ON CONFLICT DO NOTHING`,
      [req.params.id, userId]
    );
    await pool.query(
      `INSERT INTO activity_log (group_id, actor_id, type, summary) VALUES ($1, $2, 'member_added', $3)`,
      [req.params.id, authReq.user.id, `${authReq.user.name || authReq.user.username} added ${userRes.rows[0].name || userRes.rows[0].username}`]
    );

    res.status(201).json({ message: 'Member added' });
  } catch (error) {
    console.error('Add member error:', error);
    res.status(500).json({ error: 'Failed to add member' });
  }
});

// Group balances + simplified debts. 403 for non-members.
router.get('/:id/balances', authMiddleware, async (req: Request, res: Response): Promise<void> => {
  try {
    const authReq = req as AuthenticatedRequest;
    const membership = await getGroupMembership(req.params.id, authReq.user.id);
    if (!membership) {
      res.status(403).json({ error: 'You are not a member of this group' });
      return;
    }
    const balances = await computeGroupBalances(req.params.id);
    res.json(balances);
  } catch (error) {
    console.error('Get balances error:', error);
    res.status(500).json({ error: 'Failed to compute balances' });
  }
});

export default router;
