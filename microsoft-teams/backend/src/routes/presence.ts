import { Router, Request, Response } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { logger } from '../services/logger.js';
import { presenceUpdatesTotal } from '../services/metrics.js';
import { setUserOnline, getOnlineUsers } from '../services/presenceService.js';
import { pool } from '../services/db.js';
import { requireChannel, respondError } from '../services/accessService.js';

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
router.get('/channel/:channelId', requireAuth, async (req: Request, res: Response) => {
  try {
    const channel = await requireChannel(req.params.channelId, req.session.userId!);
    // Channel rows alone aren't enough: someone removed from the team keeps no
    // access, so only list people who still hold the team membership too.
    const result = await pool.query(
      `SELECT u.id, u.username, u.display_name, u.avatar_url
       FROM channel_members cm
       JOIN users u ON cm.user_id = u.id
       JOIN team_members tm ON tm.user_id = cm.user_id AND tm.team_id = $2
       WHERE cm.channel_id = $1
       ORDER BY u.display_name`,
      [channel.channelId, channel.teamId],
    );

    const userIds = result.rows.map((r) => r.id);
    const presence = await getOnlineUsers(userIds);

    const members = result.rows.map((user) => ({
      ...user,
      isOnline: presence[user.id] || false,
    }));

    res.json({ members });
  } catch (err) {
    respondError(res, err, 'Failed to get channel presence');
  }
});

export default router;
