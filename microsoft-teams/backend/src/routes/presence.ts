import { Router, Request, Response } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { requireChannelAccess } from '../middleware/access.js';
import { logger } from '../services/logger.js';
import { presenceUpdatesTotal } from '../services/metrics.js';
import { setUserOnline, getOnlineUsers } from '../services/presenceService.js';
import { pool } from '../services/db.js';

const router = Router();

// POST /api/presence/heartbeat - send presence heartbeat
router.post('/heartbeat', requireAuth, async (req: Request, res: Response) => {
  try {
    await setUserOnline(req.session.userId!);
    presenceUpdatesTotal.inc();
    res.json({ status: 'ok' });
  } catch (err) {
    logger.error({ err }, 'Failed to update presence');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/presence/channel/:channelId - get channel member presence
router.get(
  '/channel/:channelId',
  requireAuth,
  requireChannelAccess((req) => req.params.channelId),
  async (req: Request, res: Response) => {
    try {
      const result = await pool.query(
        `SELECT u.id, u.username, u.display_name, u.avatar_url
         FROM channel_members cm
         JOIN users u ON cm.user_id = u.id
         WHERE cm.channel_id = $1`,
        [req.channelAccess!.channelId],
      );

      const userIds = result.rows.map((r) => r.id);
      const presence = await getOnlineUsers(userIds);

      const members = result.rows.map((user) => ({
        ...user,
        isOnline: presence[user.id] || false,
      }));

      res.json({ members });
    } catch (err) {
      logger.error({ err }, 'Failed to get channel presence');
      res.status(500).json({ error: 'Internal server error' });
    }
  },
);

export default router;
