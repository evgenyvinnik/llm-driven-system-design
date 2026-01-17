import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { query } from '../db/index.js';
import { requireAuth, requireWorkspace } from '../middleware/auth.js';
import type { Channel } from '../types/index.js';

const router = Router();

// Get direct messages for current workspace
router.get('/', requireAuth, requireWorkspace, async (req: Request, res: Response): Promise<void> => {
  try {
    const workspaceId = req.session.workspaceId;
    const userId = req.session.userId;

    // Get DM channels where user is a member
    const result = await query(
      `SELECT c.*,
        (SELECT json_agg(json_build_object(
          'id', u.id,
          'username', u.username,
          'display_name', u.display_name,
          'avatar_url', u.avatar_url
        ))
        FROM channel_members cm2
        INNER JOIN users u ON u.id = cm2.user_id
        WHERE cm2.channel_id = c.id AND cm2.user_id != $2
        ) as other_members,
        (SELECT m.content FROM messages m WHERE m.channel_id = c.id ORDER BY m.created_at DESC LIMIT 1) as last_message,
        (SELECT m.created_at FROM messages m WHERE m.channel_id = c.id ORDER BY m.created_at DESC LIMIT 1) as last_message_at
       FROM channels c
       INNER JOIN channel_members cm ON cm.channel_id = c.id AND cm.user_id = $2
       WHERE c.workspace_id = $1 AND c.is_dm = true
       ORDER BY last_message_at DESC NULLS LAST`,
      [workspaceId, userId]
    );

    res.json(result.rows);
  } catch (error) {
    console.error('Get DMs error:', error);
    res.status(500).json({ error: 'Failed to get direct messages' });
  }
});

// Create or get direct message channel
router.post('/', requireAuth, requireWorkspace, async (req: Request, res: Response): Promise<void> => {
  try {
    const { user_ids } = req.body;
    const workspaceId = req.session.workspaceId;
    const currentUserId = req.session.userId;

    if (!user_ids || !Array.isArray(user_ids) || user_ids.length === 0) {
      res.status(400).json({ error: 'At least one user ID is required' });
      return;
    }

    // Include current user in the member list
    const allUserIds = [...new Set([currentUserId, ...user_ids])].sort();

    // Check if DM already exists with these exact members
    const existingDM = await query<{ id: string }>(
      `SELECT c.id FROM channels c
       WHERE c.workspace_id = $1 AND c.is_dm = true
       AND (
         SELECT array_agg(cm.user_id ORDER BY cm.user_id)
         FROM channel_members cm WHERE cm.channel_id = c.id
       ) = $2::uuid[]`,
      [workspaceId, allUserIds]
    );

    if (existingDM.rows.length > 0) {
      const dmResult = await query<Channel>('SELECT * FROM channels WHERE id = $1', [existingDM.rows[0].id]);
      res.json(dmResult.rows[0]);
      return;
    }

    // Create new DM channel
    const channelId = uuidv4();
    const dmName = `dm-${channelId.slice(0, 8)}`; // Generate unique name

    await query(
      `INSERT INTO channels (id, workspace_id, name, is_dm, is_private, created_by)
       VALUES ($1, $2, $3, true, true, $4)`,
      [channelId, workspaceId, dmName, currentUserId]
    );

    // Add all members
    for (const memberId of allUserIds) {
      await query(
        'INSERT INTO channel_members (channel_id, user_id) VALUES ($1, $2)',
        [channelId, memberId]
      );
    }

    const result = await query<Channel>('SELECT * FROM channels WHERE id = $1', [channelId]);

    // Get member info
    const members = await query(
      `SELECT u.id, u.username, u.display_name, u.avatar_url
       FROM users u
       INNER JOIN channel_members cm ON cm.user_id = u.id
       WHERE cm.channel_id = $1`,
      [channelId]
    );

    res.status(201).json({
      ...result.rows[0],
      members: members.rows,
    });
  } catch (error) {
    console.error('Create DM error:', error);
    res.status(500).json({ error: 'Failed to create direct message' });
  }
});

// Get DM channel details
router.get('/:id', requireAuth, requireWorkspace, async (req: Request, res: Response): Promise<void> => {
  try {
    // Check membership
    const membership = await query(
      'SELECT 1 FROM channel_members WHERE channel_id = $1 AND user_id = $2',
      [req.params.id, req.session.userId]
    );

    if (membership.rows.length === 0) {
      res.status(403).json({ error: 'Not a member of this conversation' });
      return;
    }

    const result = await query<Channel>(
      'SELECT * FROM channels WHERE id = $1 AND is_dm = true',
      [req.params.id]
    );

    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Conversation not found' });
      return;
    }

    // Get member info
    const members = await query(
      `SELECT u.id, u.username, u.display_name, u.avatar_url
       FROM users u
       INNER JOIN channel_members cm ON cm.user_id = u.id
       WHERE cm.channel_id = $1`,
      [req.params.id]
    );

    res.json({
      ...result.rows[0],
      members: members.rows,
    });
  } catch (error) {
    console.error('Get DM error:', error);
    res.status(500).json({ error: 'Failed to get conversation' });
  }
});

export default router;
