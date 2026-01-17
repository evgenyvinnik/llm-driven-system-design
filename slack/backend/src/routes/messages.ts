import { Router, Request, Response } from 'express';
import { query } from '../db/index.js';
import { requireAuth, requireWorkspace } from '../middleware/auth.js';
import { publishToUser } from '../services/redis.js';
import { indexMessage, updateMessageIndex, deleteMessageIndex } from '../services/elasticsearch.js';
import type { Message } from '../types/index.js';

const router = Router();

// Get messages for a channel
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
    console.error('Get messages error:', error);
    res.status(500).json({ error: 'Failed to get messages' });
  }
});

// Get thread replies
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
    console.error('Get thread error:', error);
    res.status(500).json({ error: 'Failed to get thread' });
  }
});

// Send message
router.post('/channel/:channelId', requireAuth, requireWorkspace, async (req: Request, res: Response): Promise<void> => {
  try {
    const { channelId } = req.params;
    const { content, thread_ts, attachments } = req.body;
    const workspaceId = req.session.workspaceId!;
    const userId = req.session.userId!;

    if (!content || content.trim() === '') {
      res.status(400).json({ error: 'Message content is required' });
      return;
    }

    // Verify channel membership
    const membership = await query(
      'SELECT 1 FROM channel_members WHERE channel_id = $1 AND user_id = $2',
      [channelId, userId]
    );

    if (membership.rows.length === 0) {
      res.status(403).json({ error: 'Not a member of this channel' });
      return;
    }

    // Insert message
    const result = await query<Message>(
      `INSERT INTO messages (workspace_id, channel_id, user_id, content, thread_ts, attachments)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [workspaceId, channelId, userId, content.trim(), thread_ts || null, attachments ? JSON.stringify(attachments) : null]
    );

    const message = result.rows[0];

    // If this is a thread reply, update parent reply_count
    if (thread_ts) {
      await query(
        'UPDATE messages SET reply_count = reply_count + 1 WHERE id = $1',
        [thread_ts]
      );
    }

    // Get user info for response
    const userResult = await query(
      'SELECT username, display_name, avatar_url FROM users WHERE id = $1',
      [userId]
    );

    const messageWithUser = {
      ...message,
      ...userResult.rows[0],
      reactions: null,
    };

    // Publish to channel members
    const members = await query<{ user_id: string }>(
      'SELECT user_id FROM channel_members WHERE channel_id = $1',
      [channelId]
    );

    for (const member of members.rows) {
      await publishToUser(member.user_id, {
        type: 'message',
        payload: messageWithUser,
      });
    }

    // Index for search (async)
    indexMessage({
      id: message.id,
      workspace_id: workspaceId,
      channel_id: channelId,
      user_id: userId,
      content: content.trim(),
      created_at: message.created_at,
    }).catch(console.error);

    res.status(201).json(messageWithUser);
  } catch (error) {
    console.error('Send message error:', error);
    res.status(500).json({ error: 'Failed to send message' });
  }
});

// Update message
router.put('/:messageId', requireAuth, requireWorkspace, async (req: Request, res: Response): Promise<void> => {
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

    // Get user info
    const userResult = await query(
      'SELECT username, display_name, avatar_url FROM users WHERE id = $1',
      [req.session.userId]
    );

    const messageWithUser = {
      ...message,
      ...userResult.rows[0],
    };

    // Publish update to channel members
    const members = await query<{ user_id: string }>(
      'SELECT user_id FROM channel_members WHERE channel_id = $1',
      [message.channel_id]
    );

    for (const member of members.rows) {
      await publishToUser(member.user_id, {
        type: 'message_update',
        payload: messageWithUser,
      });
    }

    // Update search index
    updateMessageIndex(message.id, content.trim()).catch(console.error);

    res.json(messageWithUser);
  } catch (error) {
    console.error('Update message error:', error);
    res.status(500).json({ error: 'Failed to update message' });
  }
});

// Delete message
router.delete('/:messageId', requireAuth, requireWorkspace, async (req: Request, res: Response): Promise<void> => {
  try {
    const { messageId } = req.params;

    // Verify ownership
    const existing = await query<Message>(
      'SELECT * FROM messages WHERE id = $1 AND user_id = $2',
      [messageId, req.session.userId]
    );

    if (existing.rows.length === 0) {
      res.status(404).json({ error: 'Message not found or you do not have permission to delete it' });
      return;
    }

    const message = existing.rows[0];

    // Delete message (cascade will handle reactions and thread replies)
    await query('DELETE FROM messages WHERE id = $1', [messageId]);

    // If this was a thread reply, update parent reply_count
    if (message.thread_ts) {
      await query(
        'UPDATE messages SET reply_count = reply_count - 1 WHERE id = $1',
        [message.thread_ts]
      );
    }

    // Publish delete to channel members
    const members = await query<{ user_id: string }>(
      'SELECT user_id FROM channel_members WHERE channel_id = $1',
      [message.channel_id]
    );

    for (const member of members.rows) {
      await publishToUser(member.user_id, {
        type: 'message_delete',
        payload: { id: parseInt(messageId, 10), channel_id: message.channel_id },
      });
    }

    // Remove from search index
    deleteMessageIndex(parseInt(messageId, 10)).catch(console.error);

    res.json({ message: 'Message deleted' });
  } catch (error) {
    console.error('Delete message error:', error);
    res.status(500).json({ error: 'Failed to delete message' });
  }
});

// Add reaction
router.post('/:messageId/reactions', requireAuth, requireWorkspace, async (req: Request, res: Response): Promise<void> => {
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

    // Add reaction
    await query(
      `INSERT INTO reactions (message_id, user_id, emoji)
       VALUES ($1, $2, $3)
       ON CONFLICT DO NOTHING`,
      [messageId, req.session.userId, emoji]
    );

    // Publish to channel members
    const members = await query<{ user_id: string }>(
      'SELECT user_id FROM channel_members WHERE channel_id = $1',
      [message.rows[0].channel_id]
    );

    for (const member of members.rows) {
      await publishToUser(member.user_id, {
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
    console.error('Add reaction error:', error);
    res.status(500).json({ error: 'Failed to add reaction' });
  }
});

// Remove reaction
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

    // Remove reaction
    await query(
      'DELETE FROM reactions WHERE message_id = $1 AND user_id = $2 AND emoji = $3',
      [messageId, req.session.userId, emoji]
    );

    // Publish to channel members
    const members = await query<{ user_id: string }>(
      'SELECT user_id FROM channel_members WHERE channel_id = $1',
      [message.rows[0].channel_id]
    );

    for (const member of members.rows) {
      await publishToUser(member.user_id, {
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
    console.error('Remove reaction error:', error);
    res.status(500).json({ error: 'Failed to remove reaction' });
  }
});

export default router;
