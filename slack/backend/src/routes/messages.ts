/**
 * @fileoverview Message routes for sending, receiving, and managing messages.
 * Handles message CRUD, threading, reactions, and real-time delivery via WebSocket.
 * Messages are indexed in Elasticsearch for search functionality.
 * Includes idempotency protection, rate limiting, and cache integration.
 */

import { Router, Request, Response } from 'express';
import { query, withTransaction } from '../db/index.js';
import { requireAuth, requireWorkspace } from '../middleware/auth.js';
import { idempotencyMiddleware } from '../middleware/idempotency.js';
import { rateLimit } from '../middleware/rateLimit.js';
import { loadMembership, hasPermission } from '../middleware/rbac.js';
import { publishToUser } from '../services/redis.js';
import { indexMessage, updateMessageIndex, deleteMessageIndex } from '../services/elasticsearch.js';
import { getCachedChannelMembers, getCachedUser, invalidateChannelCache } from '../services/cache.js';
import { logger } from '../services/logger.js';
import { messagesSentCounter } from '../services/metrics.js';
import type { Message, Channel } from '../types/index.js';

const router = Router();

/**
 * GET /messages/channel/:channelId - Get messages for a channel.
 * Returns top-level messages (not thread replies) with pagination support.
 * Includes author info and reactions for each message.
 */
router.get('/channel/:channelId', requireAuth, requireWorkspace, async (req: Request, res: Response): Promise<void> => {
  try {
    const { channelId } = req.params;
    const { before, limit = '50' } = req.query;

    // Verify channel access
    const channelCheck = await query(
      `SELECT c.id, c.is_private FROM channels c
       WHERE c.id = $1 AND c.workspace_id = $2`,
      [channelId, req.session.workspaceId]
    );

    if (channelCheck.rows.length === 0) {
      res.status(404).json({ error: 'Channel not found' });
      return;
    }

    const channel = channelCheck.rows[0];

    if (channel.is_private) {
      const membership = await query(
        'SELECT 1 FROM channel_members WHERE channel_id = $1 AND user_id = $2',
        [channelId, req.session.userId]
      );

      if (membership.rows.length === 0) {
        res.status(403).json({ error: 'Not a member of this channel' });
        return;
      }
    }

    // Get messages (top-level only, not thread replies)
    let messagesQuery = `
      SELECT m.*,
        u.username, u.display_name, u.avatar_url,
        (SELECT json_agg(json_build_object('emoji', r.emoji, 'user_id', r.user_id))
         FROM reactions r WHERE r.message_id = m.id) as reactions
      FROM messages m
      INNER JOIN users u ON u.id = m.user_id
      WHERE m.channel_id = $1 AND m.thread_ts IS NULL
    `;

    const params: unknown[] = [channelId];

    if (before) {
      messagesQuery += ' AND m.id < $2';
      params.push(parseInt(before as string, 10));
    }

    messagesQuery += ' ORDER BY m.created_at DESC LIMIT $' + (params.length + 1);
    params.push(parseInt(limit as string, 10));

    const result = await query(messagesQuery, params);

    // Reverse to get chronological order
    res.json(result.rows.reverse());
  } catch (error) {
    logger.error({ err: error, msg: 'Get messages error' });
    res.status(500).json({ error: 'Failed to get messages' });
  }
});

/**
 * GET /messages/:messageId/thread - Get a thread with all replies.
 * Returns the parent message and all replies in chronological order.
 */
router.get('/:messageId/thread', requireAuth, requireWorkspace, async (req: Request, res: Response): Promise<void> => {
  try {
    const { messageId } = req.params;

    // Get parent message
    const parentResult = await query(
      `SELECT m.*, u.username, u.display_name, u.avatar_url,
        (SELECT json_agg(json_build_object('emoji', r.emoji, 'user_id', r.user_id))
         FROM reactions r WHERE r.message_id = m.id) as reactions
       FROM messages m
       INNER JOIN users u ON u.id = m.user_id
       WHERE m.id = $1`,
      [messageId]
    );

    if (parentResult.rows.length === 0) {
      res.status(404).json({ error: 'Message not found' });
      return;
    }

    // Get replies
    const repliesResult = await query(
      `SELECT m.*, u.username, u.display_name, u.avatar_url,
        (SELECT json_agg(json_build_object('emoji', r.emoji, 'user_id', r.user_id))
         FROM reactions r WHERE r.message_id = m.id) as reactions
       FROM messages m
       INNER JOIN users u ON u.id = m.user_id
       WHERE m.thread_ts = $1
       ORDER BY m.created_at ASC`,
      [messageId]
    );

    res.json({
      parent: parentResult.rows[0],
      replies: repliesResult.rows,
    });
  } catch (error) {
    logger.error({ err: error, msg: 'Get thread error' });
    res.status(500).json({ error: 'Failed to get thread' });
  }
});

/**
 * POST /messages/channel/:channelId - Send a new message to a channel.
 * Publishes the message to all channel members via Redis pub/sub.
 * Indexes the message in Elasticsearch for search.
 *
 * Protected by:
 * - Authentication (requireAuth)
 * - Workspace context (requireWorkspace)
 * - Rate limiting (60 messages/minute)
 * - Idempotency (X-Idempotency-Key header)
 */
router.post(
  '/channel/:channelId',
  requireAuth,
  requireWorkspace,
  loadMembership(),
  rateLimit('SEND_MESSAGE'),
  idempotencyMiddleware(),
  async (req: Request, res: Response): Promise<void> => {
    try {
      const { channelId } = req.params;
      const { content, thread_ts, attachments } = req.body;
      const workspaceId = req.session.workspaceId!;
      const userId = req.session.userId!;

      if (!content || content.trim() === '') {
        res.status(400).json({ error: 'Message content is required' });
        return;
      }

      // Verify channel membership (use cache for frequent lookups)
      const channelMembers = await getCachedChannelMembers(channelId);
      if (!channelMembers.includes(userId)) {
        res.status(403).json({ error: 'Not a member of this channel' });
        return;
      }

      // Use transaction for atomicity (especially important for thread replies)
      const message = await withTransaction(async (client) => {
        // Insert message
        const result = await client.query<Message>(
          `INSERT INTO messages (workspace_id, channel_id, user_id, content, thread_ts, attachments)
           VALUES ($1, $2, $3, $4, $5, $6)
           RETURNING *`,
          [workspaceId, channelId, userId, content.trim(), thread_ts || null, attachments ? JSON.stringify(attachments) : null]
        );

        const msg = result.rows[0];

        // If this is a thread reply, update parent reply_count atomically
        if (thread_ts) {
          await client.query(
            `UPDATE messages SET
               reply_count = reply_count + 1,
               latest_reply = NOW(),
               reply_users = array_append(array_remove(COALESCE(reply_users, ARRAY[]::uuid[]), $1::uuid), $1::uuid)
             WHERE id = $2`,
            [userId, thread_ts]
          );
        }

        return msg;
      });

      // Get user info (use cache)
      const user = await getCachedUser(userId);

      const messageWithUser = {
        ...message,
        username: user?.username,
        display_name: user?.display_name,
        avatar_url: user?.avatar_url,
        reactions: null,
      };

      // Publish to channel members (use cached member list)
      for (const memberId of channelMembers) {
        await publishToUser(memberId, {
          type: 'message',
          payload: messageWithUser,
        });
      }

      // Record metrics
      const channelResult = await query<Channel>('SELECT is_private, is_dm FROM channels WHERE id = $1', [channelId]);
      const channelType = channelResult.rows[0]?.is_dm ? 'dm' : channelResult.rows[0]?.is_private ? 'private' : 'public';
      messagesSentCounter.inc({ workspace_id: workspaceId, channel_type: channelType });

      // Index for search (async, non-blocking)
      indexMessage({
        id: message.id,
        workspace_id: workspaceId,
        channel_id: channelId,
        user_id: userId,
        content: content.trim(),
        created_at: message.created_at,
      }).catch((err) => logger.error({ err, msg: 'Failed to index message' }));

      logger.info({
        msg: 'Message sent',
        messageId: message.id,
        channelId,
        userId,
        hasThread: !!thread_ts,
      });

      res.status(201).json(messageWithUser);
    } catch (error) {
      logger.error({ err: error, msg: 'Send message error' });
      res.status(500).json({ error: 'Failed to send message' });
    }
  }
);

/**
 * PUT /messages/:messageId - Edit an existing message.
 * Only the message author can edit. Updates timestamp and notifies channel members.
 */
router.put(
  '/:messageId',
  requireAuth,
  requireWorkspace,
  rateLimit('EDIT_MESSAGE'),
  async (req: Request, res: Response): Promise<void> => {
    try {
      const { messageId } = req.params;
      const { content } = req.body;

      if (!content || content.trim() === '') {
        res.status(400).json({ error: 'Message content is required' });
        return;
      }

      // Verify ownership
      const existing = await query<Message>(
        'SELECT * FROM messages WHERE id = $1 AND user_id = $2',
        [messageId, req.session.userId]
      );

      if (existing.rows.length === 0) {
        res.status(404).json({ error: 'Message not found or you do not have permission to edit it' });
        return;
      }

      // Update message
      const result = await query<Message>(
        `UPDATE messages SET content = $1, edited_at = NOW()
         WHERE id = $2
         RETURNING *`,
        [content.trim(), messageId]
      );

      const message = result.rows[0];

      // Get user info (use cache)
      const user = await getCachedUser(req.session.userId!);

      const messageWithUser = {
        ...message,
        username: user?.username,
        display_name: user?.display_name,
        avatar_url: user?.avatar_url,
      };

      // Publish update to channel members (use cache)
      const channelMembers = await getCachedChannelMembers(message.channel_id);
      for (const memberId of channelMembers) {
        await publishToUser(memberId, {
          type: 'message_update',
          payload: messageWithUser,
        });
      }

      // Update search index
      updateMessageIndex(message.id, content.trim()).catch((err) =>
        logger.error({ err, msg: 'Failed to update message index' })
      );

      logger.info({ msg: 'Message updated', messageId: message.id });

      res.json(messageWithUser);
    } catch (error) {
      logger.error({ err: error, msg: 'Update message error' });
      res.status(500).json({ error: 'Failed to update message' });
    }
  }
);

/**
 * DELETE /messages/:messageId - Delete a message.
 * Only the message author can delete (or admins with DELETE_ANY_MESSAGE permission).
 * Cascades to reactions and thread replies.
 * Notifies channel members and removes from search index.
 */
router.delete(
  '/:messageId',
  requireAuth,
  requireWorkspace,
  loadMembership(),
  rateLimit('DELETE_MESSAGE'),
  async (req: Request, res: Response): Promise<void> => {
    try {
      const { messageId } = req.params;
      const userId = req.session.userId!;

      // Check ownership or admin permission
      const existing = await query<Message>(
        'SELECT * FROM messages WHERE id = $1',
        [messageId]
      );

      if (existing.rows.length === 0) {
        res.status(404).json({ error: 'Message not found' });
        return;
      }

      const message = existing.rows[0];

      // Check if user can delete this message
      const isOwner = message.user_id === userId;
      const canDeleteAny = req.membership && hasPermission(req.membership.role as 'guest' | 'member' | 'admin' | 'owner', 'DELETE_ANY_MESSAGE');

      if (!isOwner && !canDeleteAny) {
        res.status(403).json({ error: 'You do not have permission to delete this message' });
        return;
      }

      // Delete message (cascade will handle reactions and thread replies)
      await query('DELETE FROM messages WHERE id = $1', [messageId]);

      // If this was a thread reply, update parent reply_count
      if (message.thread_ts) {
        await query(
          'UPDATE messages SET reply_count = reply_count - 1 WHERE id = $1',
          [message.thread_ts]
        );
      }

      // Publish delete to channel members (use cache)
      const channelMembers = await getCachedChannelMembers(message.channel_id);
      for (const memberId of channelMembers) {
        await publishToUser(memberId, {
          type: 'message_delete',
          payload: { id: parseInt(messageId, 10), channel_id: message.channel_id },
        });
      }

      // Remove from search index
      deleteMessageIndex(parseInt(messageId, 10)).catch((err) =>
        logger.error({ err, msg: 'Failed to delete message from index' })
      );

      logger.info({
        msg: 'Message deleted',
        messageId: message.id,
        deletedBy: userId,
        wasOwner: isOwner,
      });

      res.json({ message: 'Message deleted' });
    } catch (error) {
      logger.error({ err: error, msg: 'Delete message error' });
      res.status(500).json({ error: 'Failed to delete message' });
    }
  }
);

/**
 * POST /messages/:messageId/reactions - Add an emoji reaction to a message.
 * Each user can add one reaction per emoji. Notifies channel members in real-time.
 */
router.post(
  '/:messageId/reactions',
  requireAuth,
  requireWorkspace,
  rateLimit('ADD_REACTION'),
  async (req: Request, res: Response): Promise<void> => {
    try {
      const { messageId } = req.params;
      const { emoji } = req.body;

      if (!emoji) {
        res.status(400).json({ error: 'Emoji is required' });
        return;
      }

      // Verify message exists
      const message = await query<Message>(
        'SELECT * FROM messages WHERE id = $1',
        [messageId]
      );

      if (message.rows.length === 0) {
        res.status(404).json({ error: 'Message not found' });
        return;
      }

      // Add reaction (idempotent via ON CONFLICT)
      await query(
        `INSERT INTO reactions (message_id, user_id, emoji)
         VALUES ($1, $2, $3)
         ON CONFLICT DO NOTHING`,
        [messageId, req.session.userId, emoji]
      );

      // Publish to channel members (use cache)
      const channelMembers = await getCachedChannelMembers(message.rows[0].channel_id);
      for (const memberId of channelMembers) {
        await publishToUser(memberId, {
          type: 'reaction_add',
          payload: {
            message_id: parseInt(messageId, 10),
            user_id: req.session.userId,
            emoji,
          },
        });
      }

      res.json({ message: 'Reaction added' });
    } catch (error) {
      logger.error({ err: error, msg: 'Add reaction error' });
      res.status(500).json({ error: 'Failed to add reaction' });
    }
  }
);

/**
 * DELETE /messages/:messageId/reactions/:emoji - Remove a reaction from a message.
 * Removes the current user's reaction of the specified emoji.
 */
router.delete('/:messageId/reactions/:emoji', requireAuth, requireWorkspace, async (req: Request, res: Response): Promise<void> => {
  try {
    const { messageId, emoji } = req.params;

    // Verify message exists
    const message = await query<Message>(
      'SELECT * FROM messages WHERE id = $1',
      [messageId]
    );

    if (message.rows.length === 0) {
      res.status(404).json({ error: 'Message not found' });
      return;
    }

    // Remove reaction (idempotent)
    await query(
      'DELETE FROM reactions WHERE message_id = $1 AND user_id = $2 AND emoji = $3',
      [messageId, req.session.userId, emoji]
    );

    // Publish to channel members (use cache)
    const channelMembers = await getCachedChannelMembers(message.rows[0].channel_id);
    for (const memberId of channelMembers) {
      await publishToUser(memberId, {
        type: 'reaction_remove',
        payload: {
          message_id: parseInt(messageId, 10),
          user_id: req.session.userId,
          emoji,
        },
      });
    }

    res.json({ message: 'Reaction removed' });
  } catch (error) {
    logger.error({ err: error, msg: 'Remove reaction error' });
    res.status(500).json({ error: 'Failed to remove reaction' });
  }
});

export default router;
