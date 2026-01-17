import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { query } from '../db/index.js';
import { requireAuth, requireWorkspace } from '../middleware/auth.js';
import type { Channel, ChannelMember } from '../types/index.js';

const router = Router();

// Get channels for current workspace
router.get('/', requireAuth, requireWorkspace, async (req: Request, res: Response): Promise<void> => {
  try {
    const workspaceId = req.session.workspaceId;

    // Get all channels user is a member of
    const result = await query<Channel & { is_member: boolean; unread_count: number }>(
      `SELECT c.*,
        EXISTS(SELECT 1 FROM channel_members cm WHERE cm.channel_id = c.id AND cm.user_id = $2) as is_member,
        (SELECT COUNT(*) FROM messages m WHERE m.channel_id = c.id
         AND m.created_at > COALESCE(
           (SELECT last_read_at FROM channel_members WHERE channel_id = c.id AND user_id = $2),
           '1970-01-01'
         )
        ) as unread_count
       FROM channels c
       WHERE c.workspace_id = $1 AND c.is_dm = false AND c.is_archived = false
       AND (c.is_private = false OR EXISTS(
         SELECT 1 FROM channel_members cm WHERE cm.channel_id = c.id AND cm.user_id = $2
       ))
       ORDER BY c.name`,
      [workspaceId, req.session.userId]
    );

    res.json(result.rows);
  } catch (error) {
    console.error('Get channels error:', error);
    res.status(500).json({ error: 'Failed to get channels' });
  }
});

// Create channel
router.post('/', requireAuth, requireWorkspace, async (req: Request, res: Response): Promise<void> => {
  try {
    const { name, topic, description, is_private } = req.body;
    const workspaceId = req.session.workspaceId;

    if (!name) {
      res.status(400).json({ error: 'Channel name is required' });
      return;
    }

    // Validate channel name (lowercase, no spaces)
    const normalizedName = name.toLowerCase().replace(/\s+/g, '-');

    // Check if channel exists
    const existing = await query(
      'SELECT id FROM channels WHERE workspace_id = $1 AND name = $2',
      [workspaceId, normalizedName]
    );

    if (existing.rows.length > 0) {
      res.status(400).json({ error: 'Channel already exists' });
      return;
    }

    const channelId = uuidv4();

    // Create channel
    await query(
      `INSERT INTO channels (id, workspace_id, name, topic, description, is_private, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [channelId, workspaceId, normalizedName, topic, description, is_private || false, req.session.userId]
    );

    // Add creator to channel
    await query(
      'INSERT INTO channel_members (channel_id, user_id) VALUES ($1, $2)',
      [channelId, req.session.userId]
    );

    const result = await query<Channel>('SELECT * FROM channels WHERE id = $1', [channelId]);

    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error('Create channel error:', error);
    res.status(500).json({ error: 'Failed to create channel' });
  }
});

// Get channel details
router.get('/:id', requireAuth, requireWorkspace, async (req: Request, res: Response): Promise<void> => {
  try {
    const result = await query<Channel>(
      'SELECT * FROM channels WHERE id = $1 AND workspace_id = $2',
      [req.params.id, req.session.workspaceId]
    );

    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Channel not found' });
      return;
    }

    const channel = result.rows[0];

    // Check access for private channels
    if (channel.is_private) {
      const membership = await query(
        'SELECT 1 FROM channel_members WHERE channel_id = $1 AND user_id = $2',
        [req.params.id, req.session.userId]
      );

      if (membership.rows.length === 0) {
        res.status(403).json({ error: 'Not a member of this channel' });
        return;
      }
    }

    res.json(channel);
  } catch (error) {
    console.error('Get channel error:', error);
    res.status(500).json({ error: 'Failed to get channel' });
  }
});

// Update channel
router.put('/:id', requireAuth, requireWorkspace, async (req: Request, res: Response): Promise<void> => {
  try {
    const { topic, description } = req.body;

    const result = await query<Channel>(
      `UPDATE channels SET
        topic = COALESCE($1, topic),
        description = COALESCE($2, description),
        updated_at = NOW()
       WHERE id = $3 AND workspace_id = $4
       RETURNING *`,
      [topic, description, req.params.id, req.session.workspaceId]
    );

    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Channel not found' });
      return;
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Update channel error:', error);
    res.status(500).json({ error: 'Failed to update channel' });
  }
});

// Join channel
router.post('/:id/join', requireAuth, requireWorkspace, async (req: Request, res: Response): Promise<void> => {
  try {
    const channelId = req.params.id;

    // Check channel exists and is not private
    const channel = await query<Channel>(
      'SELECT * FROM channels WHERE id = $1 AND workspace_id = $2',
      [channelId, req.session.workspaceId]
    );

    if (channel.rows.length === 0) {
      res.status(404).json({ error: 'Channel not found' });
      return;
    }

    if (channel.rows[0].is_private) {
      res.status(403).json({ error: 'Cannot join private channel without invitation' });
      return;
    }

    // Add to channel
    await query(
      'INSERT INTO channel_members (channel_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [channelId, req.session.userId]
    );

    res.json({ message: 'Joined channel successfully' });
  } catch (error) {
    console.error('Join channel error:', error);
    res.status(500).json({ error: 'Failed to join channel' });
  }
});

// Leave channel
router.post('/:id/leave', requireAuth, requireWorkspace, async (req: Request, res: Response): Promise<void> => {
  try {
    await query(
      'DELETE FROM channel_members WHERE channel_id = $1 AND user_id = $2',
      [req.params.id, req.session.userId]
    );

    res.json({ message: 'Left channel successfully' });
  } catch (error) {
    console.error('Leave channel error:', error);
    res.status(500).json({ error: 'Failed to leave channel' });
  }
});

// Get channel members
router.get('/:id/members', requireAuth, requireWorkspace, async (req: Request, res: Response): Promise<void> => {
  try {
    const result = await query(
      `SELECT u.id, u.username, u.display_name, u.avatar_url, cm.joined_at
       FROM users u
       INNER JOIN channel_members cm ON u.id = cm.user_id
       WHERE cm.channel_id = $1
       ORDER BY u.display_name`,
      [req.params.id]
    );

    res.json(result.rows);
  } catch (error) {
    console.error('Get channel members error:', error);
    res.status(500).json({ error: 'Failed to get channel members' });
  }
});

// Mark channel as read
router.post('/:id/read', requireAuth, requireWorkspace, async (req: Request, res: Response): Promise<void> => {
  try {
    await query(
      'UPDATE channel_members SET last_read_at = NOW() WHERE channel_id = $1 AND user_id = $2',
      [req.params.id, req.session.userId]
    );

    res.json({ message: 'Channel marked as read' });
  } catch (error) {
    console.error('Mark read error:', error);
    res.status(500).json({ error: 'Failed to mark channel as read' });
  }
});

export default router;
