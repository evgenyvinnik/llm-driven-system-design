import { Router, Request, Response } from 'express';
import { pool, withTransaction } from '../services/db.js';
import { requireAuth } from '../middleware/auth.js';
import { evictFromChannels } from '../services/pubsub.js';
import {
  AccessError,
  isManager,
  isUuid,
  requireChannel,
  requireTeam,
  respondError,
} from '../services/accessService.js';
import { validateName } from '../services/validation.js';

const router = Router();

// GET /api/channels?teamId=xxx - list channels in team, with unread counts
router.get('/', requireAuth, async (req: Request, res: Response) => {
  try {
    const { teamId } = req.query;

    if (!teamId) {
      res.status(400).json({ error: 'teamId query parameter is required' });
      return;
    }
    // Team membership gates every channel in the team (404 for a private team
    // you're not on, 403 for a public one you haven't joined).
    const team = await requireTeam(teamId, req.session.userId!, 'member');

    // unread_count: messages from other people after the caller's last_read_at.
    // Public channels fall back to the team join time if the membership row
    // is missing, so a gap in channel_members never shows years of "unread".
    const result = await pool.query(
      `SELECT c.*, cm.user_id IS NOT NULL AS is_member,
         (SELECT COUNT(*) FROM messages m
          WHERE m.channel_id = c.id AND m.deleted_at IS NULL AND m.user_id <> $2
            AND m.created_at > COALESCE(cm.last_read_at, tm.joined_at))::int AS unread_count
       FROM channels c
       JOIN team_members tm ON tm.team_id = c.team_id AND tm.user_id = $2
       LEFT JOIN channel_members cm ON c.id = cm.channel_id AND cm.user_id = $2
       WHERE c.team_id = $1 AND (c.is_private = false OR cm.user_id IS NOT NULL)
       ORDER BY c.name`,
      [team.teamId, req.session.userId],
    );
    res.json({ channels: result.rows });
  } catch (err) {
    respondError(res, err, 'Failed to list channels');
  }
});

// POST /api/channels - create channel (team members only)
router.post('/', requireAuth, async (req: Request, res: Response) => {
  try {
    const { teamId, description, isPrivate } = req.body;

    if (!teamId) throw new AccessError(400, 'teamId and name are required');
    const name = validateName(req.body.name, 'Channel name');
    const team = await requireTeam(teamId, req.session.userId!, 'member');
    const isPrivateChannel = isPrivate === true;

    const channel = await withTransaction(async (client) => {
      const existing = await client.query(
        'SELECT 1 FROM channels WHERE team_id = $1 AND lower(name) = lower($2)',
        [team.teamId, name],
      );
      if (existing.rows.length > 0) {
        throw new AccessError(409, 'A channel with that name already exists in this team');
      }

      const result = await client.query(
        `INSERT INTO channels (team_id, name, description, is_private, created_by)
         VALUES ($1, $2, $3, $4, $5) RETURNING *`,
        [team.teamId, name, description || null, isPrivateChannel, req.session.userId],
      );
      const created = result.rows[0];

      // A public channel belongs to the whole team, so every team member gets a
      // membership row (member list, presence, unread). A private channel
      // starts with just its creator.
      if (isPrivateChannel) {
        await client.query(`INSERT INTO channel_members (channel_id, user_id) VALUES ($1, $2)`, [
          created.id,
          req.session.userId,
        ]);
      } else {
        await client.query(
          `INSERT INTO channel_members (channel_id, user_id)
           SELECT $1, user_id FROM team_members WHERE team_id = $2
           ON CONFLICT (channel_id, user_id) DO NOTHING`,
          [created.id, team.teamId],
        );
      }
      return created;
    });

    res.status(201).json({ channel: { ...channel, is_member: true, unread_count: 0 } });
  } catch (err) {
    // The unique index on (team_id, lower(name)) catches the concurrent case.
    if ((err as { code?: string }).code === '23505') {
      res.status(409).json({ error: 'A channel with that name already exists in this team' });
      return;
    }
    respondError(res, err, 'Failed to create channel');
  }
});

// GET /api/channels/:channelId - get channel details
router.get('/:channelId', requireAuth, async (req: Request, res: Response) => {
  try {
    const access = await requireChannel(req.params.channelId, req.session.userId!);
    const result = await pool.query('SELECT * FROM channels WHERE id = $1', [access.channelId]);
    res.json({ channel: { ...result.rows[0], is_member: access.isChannelMember } });
  } catch (err) {
    respondError(res, err, 'Failed to get channel');
  }
});

// GET /api/channels/:channelId/members - list channel members
router.get('/:channelId/members', requireAuth, async (req: Request, res: Response) => {
  try {
    const access = await requireChannel(req.params.channelId, req.session.userId!);
    const result = await pool.query(
      `SELECT u.id, u.username, u.display_name, u.avatar_url, cm.last_read_at, cm.joined_at
       FROM channel_members cm
       JOIN users u ON cm.user_id = u.id
       JOIN team_members tm ON tm.user_id = cm.user_id AND tm.team_id = $2
       WHERE cm.channel_id = $1
       ORDER BY u.display_name`,
      [access.channelId, access.teamId],
    );
    res.json({ members: result.rows });
  } catch (err) {
    respondError(res, err, 'Failed to list channel members');
  }
});

// POST /api/channels/:channelId/members - add a team member to a channel
//
// Used to accept any user for any channel, so anyone could add themselves to a
// private channel in another organization. Now the caller must be able to read
// the channel and the target must already be on the channel's team.
router.post('/:channelId/members', requireAuth, async (req: Request, res: Response) => {
  try {
    const access = await requireChannel(req.params.channelId, req.session.userId!);
    const { userId } = req.body;

    if (!userId) throw new AccessError(400, 'userId is required');
    if (!isUuid(userId)) throw new AccessError(404, 'User not found');

    const onTeam = await pool.query(
      'SELECT 1 FROM team_members WHERE team_id = $1 AND user_id = $2',
      [access.teamId, userId],
    );
    if (onTeam.rows.length === 0) {
      throw new AccessError(400, 'User must be a member of the team first');
    }

    const result = await pool.query(
      `INSERT INTO channel_members (channel_id, user_id)
       VALUES ($1, $2)
       ON CONFLICT (channel_id, user_id) DO NOTHING
       RETURNING id`,
      [access.channelId, userId],
    );

    res
      .status(result.rows.length > 0 ? 201 : 200)
      .json({ message: result.rows.length > 0 ? 'Member added' : 'Already a member' });
  } catch (err) {
    respondError(res, err, 'Failed to add channel member');
  }
});

// DELETE /api/channels/:channelId/members/:userId - leave or remove from a private channel
router.delete('/:channelId/members/:userId', requireAuth, async (req: Request, res: Response) => {
  try {
    const actorId = req.session.userId!;
    const access = await requireChannel(req.params.channelId, actorId);
    const targetId = req.params.userId;
    if (!isUuid(targetId)) throw new AccessError(404, 'Member not found');

    if (!access.isPrivate) {
      // Public channels are open to the whole team; leaving the team is how you leave them.
      throw new AccessError(400, 'Public channels include every team member; leave the team instead');
    }
    const canRemoveOthers = access.createdBy === actorId || isManager(access.teamRole);
    if (targetId !== actorId && !canRemoveOthers) {
      throw new AccessError(403, 'Only the channel creator or team owners/admins can remove members');
    }

    const result = await pool.query(
      'DELETE FROM channel_members WHERE channel_id = $1 AND user_id = $2 RETURNING id',
      [access.channelId, targetId],
    );
    if (result.rows.length === 0) throw new AccessError(404, 'Member not found');

    await evictFromChannels([access.channelId], targetId);
    res.json({ message: 'Member removed' });
  } catch (err) {
    respondError(res, err, 'Failed to remove channel member');
  }
});

// POST /api/channels/:channelId/read - mark channel as read
router.post('/:channelId/read', requireAuth, async (req: Request, res: Response) => {
  try {
    const access = await requireChannel(req.params.channelId, req.session.userId!);
    // Upsert so a public channel with a missing row still records the read,
    // and GREATEST keeps the read position monotonic if requests reorder.
    await pool.query(
      `INSERT INTO channel_members (channel_id, user_id, last_read_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (channel_id, user_id)
       DO UPDATE SET last_read_at = GREATEST(channel_members.last_read_at, EXCLUDED.last_read_at)`,
      [access.channelId, req.session.userId],
    );
    res.json({ message: 'Channel marked as read' });
  } catch (err) {
    respondError(res, err, 'Failed to mark channel as read');
  }
});

export default router;
