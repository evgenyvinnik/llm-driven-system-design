/**
 * @fileoverview Channel routes for managing workspace channels.
 * Handles channel CRUD, membership, and unread tracking.
 * Supports both public and private channels.
 * Includes caching for frequently accessed data and cache invalidation on updates.
 */

import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { query } from '../db/index.js';
import { requireAuth, requireWorkspace } from '../middleware/auth.js';
import { rateLimit } from '../middleware/rateLimit.js';
import { requireRole, loadMembership } from '../middleware/rbac.js';
import { getCachedChannel, invalidateChannelCache } from '../services/cache.js';
import { logger } from '../services/logger.js';
import type { Channel, ChannelMember } from '../types/index.js';

const router = Router();

/**
 * GET /channels - List channels in the current workspace.
 * Returns all public channels plus private channels the user is a member of.
 * Includes membership status and unread message counts.
 */
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
    logger.error({ err: error, msg: 'Get channels error' });
    res.status(500).json({ error: 'Failed to get channels' });
  }
});

/**
 * POST /channels - Create a new channel in the current workspace.
 * The creator is automatically added as a member.
 * Rate limited to prevent spam creation.
 */
router.post(
  '/',
  requireAuth,
  requireWorkspace,
  loadMembership(),
  rateLimit('CREATE_CHANNEL'),
  async (req: Request, res: Response): Promise<void> => {
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

      logger.info({
        msg: 'Channel created',
        channelId,
        name: normalizedName,
        isPrivate: is_private || false,
        createdBy: req.session.userId,
      });

      res.status(201).json(result.rows[0]);
    } catch (error) {
      logger.error({ err: error, msg: 'Create channel error' });
      res.status(500).json({ error: 'Failed to create channel' });
    }
  }
);

/**
 * GET /channels/:id - Get details of a specific channel.
 * Uses cache for faster lookups.
 * Requires membership for private channels.
 */
router.get('/:id', requireAuth, requireWorkspace, async (req: Request, res: Response): Promise<void> => {
  try {
    // Try cache first
    const channel = await getCachedChannel(req.params.id);

    if (!channel || channel.workspace_id !== req.session.workspaceId) {
      res.status(404).json({ error: 'Channel not found' });
      return;
    }

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
    logger.error({ err: error, msg: 'Get channel error' });
    res.status(500).json({ error: 'Failed to get channel' });
  }
});

/**
 * PUT /channels/:id - Update channel topic or description.
 * Invalidates cache after update.
 * Allows members to update channel metadata (admins can do more).
 */
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

    // Invalidate cache after update
    await invalidateChannelCache(req.params.id);

    logger.info({ msg: 'Channel updated', channelId: req.params.id });

    res.json(result.rows[0]);
  } catch (error) {
    logger.error({ err: error, msg: 'Update channel error' });
    res.status(500).json({ error: 'Failed to update channel' });
  }
});

/**
 * DELETE /channels/:id - Archive or delete a channel.
 * Only workspace owners can delete channels.
 * Invalidates cache after deletion.
 */
router.delete(
  '/:id',
  requireAuth,
  requireWorkspace,
  requireRole('owner'),
  async (req: Request, res: Response): Promise<void> => {
    try {
      // Soft delete by archiving
      const result = await query<Channel>(
        `UPDATE channels SET is_archived = true, updated_at = NOW()
         WHERE id = $1 AND workspace_id = $2
         RETURNING *`,
        [req.params.id, req.session.workspaceId]
      );

      if (result.rows.length === 0) {
        res.status(404).json({ error: 'Channel not found' });
        return;
      }

      // Invalidate cache
      await invalidateChannelCache(req.params.id);

      logger.info({
        msg: 'Channel archived',
        channelId: req.params.id,
        archivedBy: req.session.userId,
      });

      res.json({ message: 'Channel archived' });
    } catch (error) {
      logger.error({ err: error, msg: 'Delete channel error' });
      res.status(500).json({ error: 'Failed to delete channel' });
    }
  }
);

/**
 * POST /channels/:id/join - Join a public channel.
 * Returns 403 for private channels (requires invitation).
 * Invalidates members cache after joining.
 */
router.post(
  '/:id/join',
  requireAuth,
  requireWorkspace,
  rateLimit('JOIN_CHANNEL'),
  async (req: Request, res: Response): Promise<void> => {
    try {
      const channelId = req.params.id;

      // Check channel exists and is not private (use cache)
      const channel = await getCachedChannel(channelId);

      if (!channel || channel.workspace_id !== req.session.workspaceId) {
        res.status(404).json({ error: 'Channel not found' });
        return;
      }

      if (channel.is_private) {
        res.status(403).json({ error: 'Cannot join private channel without invitation' });
        return;
      }

      // Add to channel (idempotent)
      await query(
        'INSERT INTO channel_members (channel_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
        [channelId, req.session.userId]
      );

      // Invalidate members cache
      await invalidateChannelCache(channelId);

      logger.info({
        msg: 'User joined channel',
        channelId,
        userId: req.session.userId,
      });

      res.json({ message: 'Joined channel successfully' });
    } catch (error) {
      logger.error({ err: error, msg: 'Join channel error' });
      res.status(500).json({ error: 'Failed to join channel' });
    }
  }
);

/**
 * POST /channels/:id/leave - Leave a channel.
 * Removes the user from channel membership.
 * Invalidates members cache after leaving.
 */
router.post('/:id/leave', requireAuth, requireWorkspace, async (req: Request, res: Response): Promise<void> => {
  try {
    await query(
      'DELETE FROM channel_members WHERE channel_id = $1 AND user_id = $2',
      [req.params.id, req.session.userId]
    );

    // Invalidate members cache
    await invalidateChannelCache(req.params.id);

    logger.info({
      msg: 'User left channel',
      channelId: req.params.id,
      userId: req.session.userId,
    });

    res.json({ message: 'Left channel successfully' });
  } catch (error) {
    logger.error({ err: error, msg: 'Leave channel error' });
    res.status(500).json({ error: 'Failed to leave channel' });
  }
});

/**
 * GET /channels/:id/members - List all members of a channel.
 * Returns user profiles with join timestamps.
 */
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
    logger.error({ err: error, msg: 'Get channel members error' });
    res.status(500).json({ error: 'Failed to get channel members' });
  }
});

/**
 * POST /channels/:id/members - Invite a user to a channel.
 * Admins can invite to any channel, members can invite to channels they belong to.
 * Invalidates members cache after invitation.
 */
router.post(
  '/:id/members',
  requireAuth,
  requireWorkspace,
  loadMembership(),
  async (req: Request, res: Response): Promise<void> => {
    try {
      const { userId } = req.body;
      const channelId = req.params.id;

      if (!userId) {
        res.status(400).json({ error: 'userId is required' });
        return;
      }

      // Verify channel exists
      const channel = await getCachedChannel(channelId);
      if (!channel || channel.workspace_id !== req.session.workspaceId) {
        res.status(404).json({ error: 'Channel not found' });
        return;
      }

      // Check if inviter is a member of the channel
      const inviterMembership = await query(
        'SELECT 1 FROM channel_members WHERE channel_id = $1 AND user_id = $2',
        [channelId, req.session.userId]
      );

      if (inviterMembership.rows.length === 0) {
        res.status(403).json({ error: 'You must be a member to invite others' });
        return;
      }

      // Verify invitee is a workspace member
      const inviteeMembership = await query(
        'SELECT 1 FROM workspace_members WHERE workspace_id = $1 AND user_id = $2',
        [req.session.workspaceId, userId]
      );

      if (inviteeMembership.rows.length === 0) {
        res.status(400).json({ error: 'User is not a member of this workspace' });
        return;
      }

      // Add to channel (idempotent)
      await query(
        'INSERT INTO channel_members (channel_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
        [channelId, userId]
      );

      // Invalidate members cache
      await invalidateChannelCache(channelId);

      logger.info({
        msg: 'User invited to channel',
        channelId,
        invitedUserId: userId,
        invitedBy: req.session.userId,
      });

      res.json({ message: 'User invited successfully' });
    } catch (error) {
      logger.error({ err: error, msg: 'Invite to channel error' });
      res.status(500).json({ error: 'Failed to invite user' });
    }
  }
);

/**
 * DELETE /channels/:id/members/:userId - Remove a user from a channel.
 * Only admins can remove other members.
 * Invalidates members cache after removal.
 */
router.delete(
  '/:id/members/:userId',
  requireAuth,
  requireWorkspace,
  requireRole('admin'),
  async (req: Request, res: Response): Promise<void> => {
    try {
      const { id: channelId, userId } = req.params;

      await query(
        'DELETE FROM channel_members WHERE channel_id = $1 AND user_id = $2',
        [channelId, userId]
      );

      // Invalidate members cache
      await invalidateChannelCache(channelId);

      logger.info({
        msg: 'User removed from channel',
        channelId,
        removedUserId: userId,
        removedBy: req.session.userId,
      });

      res.json({ message: 'User removed from channel' });
    } catch (error) {
      logger.error({ err: error, msg: 'Remove from channel error' });
      res.status(500).json({ error: 'Failed to remove user' });
    }
  }
);

/**
 * POST /channels/:id/read - Mark a channel as read.
 * Updates the user's last_read_at timestamp for unread tracking.
 */
router.post('/:id/read', requireAuth, requireWorkspace, async (req: Request, res: Response): Promise<void> => {
  try {
    await query(
      'UPDATE channel_members SET last_read_at = NOW() WHERE channel_id = $1 AND user_id = $2',
      [req.params.id, req.session.userId]
    );

    res.json({ message: 'Channel marked as read' });
  } catch (error) {
    logger.error({ err: error, msg: 'Mark read error' });
    res.status(500).json({ error: 'Failed to mark channel as read' });
  }
});

export default router;
