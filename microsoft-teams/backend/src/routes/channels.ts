import { Router, Request, Response } from 'express';
import { pool, withTransaction } from '../services/db.js';
import { requireAuth } from '../middleware/auth.js';
import { requireChannelAccess } from '../middleware/access.js';
import {
  canCreateChannel,
  canSeeTeam,
  getTeamAccess,
  isUuid,
} from '../services/access.js';
import { logger } from '../services/logger.js';

const router = Router();

const channelFromParams = requireChannelAccess((req) => req.params.channelId);

// GET /api/channels?teamId=xxx - list channels in team: public ones plus private ones you're in
router.get('/', requireAuth, async (req: Request, res: Response) => {
  try {
    const { teamId } = req.query;

    if (!teamId || typeof teamId !== 'string') {
      res.status(400).json({ error: 'teamId query parameter is required' });
      return;
    }

    const team = await getTeamAccess(req.session.userId!, teamId);
    if (!team || !canSeeTeam(team)) {
      res.status(404).json({ error: 'Team not found' });
      return;
    }

    const result = await pool.query(
      `SELECT c.*, cm.user_id IS NOT NULL as is_member
       FROM channels c
       LEFT JOIN channel_members cm ON c.id = cm.channel_id AND cm.user_id = $2
       WHERE c.team_id = $1 AND (c.is_private = false OR cm.user_id IS NOT NULL)
       ORDER BY c.name`,
      [teamId, req.session.userId],
    );
    res.json({ channels: result.rows });
  } catch (err) {
    logger.error({ err }, 'Failed to list channels');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/channels - create channel (team members, or org owners/admins)
router.post('/', requireAuth, async (req: Request, res: Response) => {
  try {
    const { teamId, name, description, isPrivate } = req.body;

    if (!teamId || typeof name !== 'string' || !name.trim() || name.length > 100) {
      res.status(400).json({ error: 'teamId and name (max 100 characters) are required' });
      return;
    }

    const team = await getTeamAccess(req.session.userId!, teamId);
    if (!team || !canSeeTeam(team)) {
      res.status(404).json({ error: 'Team not found' });
      return;
    }
    if (!canCreateChannel(team)) {
      res.status(403).json({ error: 'Only members of this team can create channels' });
      return;
    }

    const channel = await withTransaction(async (client) => {
      const result = await client.query(
        `INSERT INTO channels (team_id, name, description, is_private, created_by)
         VALUES ($1, $2, $3, $4, $5) RETURNING *`,
        [teamId, name.trim(), description || null, isPrivate === true, req.session.userId],
      );

      // Add creator as member
      await client.query(`INSERT INTO channel_members (channel_id, user_id) VALUES ($1, $2)`, [
        result.rows[0].id,
        req.session.userId,
      ]);
      return result.rows[0];
    });

    res.status(201).json({ channel });
  } catch (err) {
    logger.error({ err }, 'Failed to create channel');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/channels/:channelId - get channel details
router.get('/:channelId', requireAuth, channelFromParams, async (req: Request, res: Response) => {
  try {
    const result = await pool.query('SELECT * FROM channels WHERE id = $1', [
      req.channelAccess!.channelId,
    ]);
    res.json({ channel: result.rows[0] });
  } catch (err) {
    logger.error({ err }, 'Failed to get channel');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/channels/:channelId/members - list channel members
router.get(
  '/:channelId/members',
  requireAuth,
  channelFromParams,
  async (req: Request, res: Response) => {
    try {
      const result = await pool.query(
        `SELECT u.id, u.username, u.display_name, u.avatar_url, cm.last_read_at, cm.joined_at
         FROM channel_members cm
         JOIN users u ON cm.user_id = u.id
         WHERE cm.channel_id = $1
         ORDER BY u.display_name`,
        [req.channelAccess!.channelId],
      );
      res.json({ members: result.rows });
    } catch (err) {
      logger.error({ err }, 'Failed to list channel members');
      res.status(500).json({ error: 'Internal server error' });
    }
  },
);

// POST /api/channels/:channelId/members - add member to channel. Anyone who can read the channel
// may add a colleague (for a private channel that already means being one of its members); the
// new member must be able to see the team.
router.post(
  '/:channelId/members',
  requireAuth,
  channelFromParams,
  async (req: Request, res: Response) => {
    try {
      const { userId } = req.body;

      if (!isUuid(userId)) {
        res.status(400).json({ error: 'userId is required' });
        return;
      }

      const target = await getTeamAccess(userId, req.channelAccess!.teamId);
      if (!target || !canSeeTeam(target)) {
        res.status(400).json({ error: 'User must be able to see this team first' });
        return;
      }

      await pool.query(
        `INSERT INTO channel_members (channel_id, user_id)
         VALUES ($1, $2)
         ON CONFLICT (channel_id, user_id) DO NOTHING`,
        [req.channelAccess!.channelId, userId],
      );

      res.status(201).json({ message: 'Member added' });
    } catch (err) {
      logger.error({ err }, 'Failed to add channel member');
      res.status(500).json({ error: 'Internal server error' });
    }
  },
);

// POST /api/channels/:channelId/read - mark channel as read
router.post(
  '/:channelId/read',
  requireAuth,
  channelFromParams,
  async (req: Request, res: Response) => {
    try {
      await pool.query(
        `UPDATE channel_members SET last_read_at = NOW()
         WHERE channel_id = $1 AND user_id = $2`,
        [req.channelAccess!.channelId, req.session.userId],
      );
      res.json({ message: 'Channel marked as read' });
    } catch (err) {
      logger.error({ err }, 'Failed to mark channel as read');
      res.status(500).json({ error: 'Internal server error' });
    }
  },
);

export default router;
