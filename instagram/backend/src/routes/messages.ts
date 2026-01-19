/**
 * @fileoverview Direct Messages API routes.
 * Handles conversation management, messaging, and real-time features.
 */

import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import {
  getOrCreateConversation,
  sendMessage,
  getMessages,
  getConversations,
  markConversationRead,
  setTypingIndicator,
  getTypingIndicators,
  addReaction,
  removeReaction,
} from '../services/messageService.js';
import { isCassandraConnected } from '../services/cassandra.js';
import { pool } from '../services/db.js';
import { logger } from '../services/logger.js';

const router = Router();

/**
 * Check if Cassandra is available middleware
 */
function requireCassandra(req, res, next) {
  if (!isCassandraConnected()) {
    return res.status(503).json({
      error: 'Direct messaging service temporarily unavailable',
    });
  }
  next();
}

/**
 * GET /api/messages/conversations
 * Get user's inbox (list of conversations)
 */
router.get('/conversations', requireAuth, requireCassandra, async (req, res) => {
  try {
    const userId = req.session.userId;
    const limit = parseInt(req.query.limit) || 20;

    const conversations = await getConversations(userId, { limit });

    res.json({ conversations });
  } catch (error) {
    logger.error({ error: error.message }, 'Failed to get conversations');
    res.status(500).json({ error: 'Failed to get conversations' });
  }
});

/**
 * POST /api/messages/conversations
 * Start a new conversation with a user
 */
router.post('/conversations', requireAuth, requireCassandra, async (req, res) => {
  try {
    const userId = req.session.userId;
    const { recipientId } = req.body;

    if (!recipientId) {
      return res.status(400).json({ error: 'recipientId is required' });
    }

    if (recipientId === userId) {
      return res.status(400).json({ error: 'Cannot message yourself' });
    }

    // Get user info from PostgreSQL
    const userQuery = 'SELECT id, username, profile_picture FROM users WHERE id = $1';
    const [senderResult, recipientResult] = await Promise.all([
      pool.query(userQuery, [userId]),
      pool.query(userQuery, [recipientId]),
    ]);

    if (senderResult.rowCount === 0) {
      return res.status(404).json({ error: 'Sender not found' });
    }
    if (recipientResult.rowCount === 0) {
      return res.status(404).json({ error: 'Recipient not found' });
    }

    const sender = senderResult.rows[0];
    const recipient = recipientResult.rows[0];

    const conversationId = await getOrCreateConversation(
      userId,
      recipientId,
      { username: sender.username, profilePicture: sender.profile_picture },
      { username: recipient.username, profilePicture: recipient.profile_picture }
    );

    res.status(201).json({
      conversationId,
      recipient: {
        id: recipient.id,
        username: recipient.username,
        profilePicture: recipient.profile_picture,
      },
    });
  } catch (error) {
    logger.error({ error: error.message }, 'Failed to create conversation');
    res.status(500).json({ error: 'Failed to create conversation' });
  }
});

/**
 * GET /api/messages/conversations/:conversationId
 * Get messages in a conversation
 */
router.get('/conversations/:conversationId', requireAuth, requireCassandra, async (req, res) => {
  try {
    const { conversationId } = req.params;
    const limit = parseInt(req.query.limit) || 50;
    const beforeMessageId = req.query.before;

    const messages = await getMessages(conversationId, { limit, beforeMessageId });

    res.json({ messages });
  } catch (error) {
    logger.error({ error: error.message, conversationId: req.params.conversationId }, 'Failed to get messages');
    res.status(500).json({ error: 'Failed to get messages' });
  }
});

/**
 * POST /api/messages/conversations/:conversationId
 * Send a message in a conversation
 */
router.post('/conversations/:conversationId', requireAuth, requireCassandra, async (req, res) => {
  try {
    const userId = req.session.userId;
    const { conversationId } = req.params;
    const { content, contentType = 'text', mediaUrl, replyToMessageId } = req.body;

    if (!content && !mediaUrl) {
      return res.status(400).json({ error: 'content or mediaUrl is required' });
    }

    const message = await sendMessage({
      conversationId,
      senderId: userId,
      content: content || '',
      contentType,
      mediaUrl,
      replyToMessageId,
    });

    res.status(201).json({ message });
  } catch (error) {
    logger.error({ error: error.message, conversationId: req.params.conversationId }, 'Failed to send message');
    res.status(500).json({ error: 'Failed to send message' });
  }
});

/**
 * POST /api/messages/conversations/:conversationId/read
 * Mark conversation as read
 */
router.post('/conversations/:conversationId/read', requireAuth, requireCassandra, async (req, res) => {
  try {
    const userId = req.session.userId;
    const { conversationId } = req.params;
    const { lastMessageId } = req.body;

    if (!lastMessageId) {
      return res.status(400).json({ error: 'lastMessageId is required' });
    }

    await markConversationRead(conversationId, userId, lastMessageId);

    res.json({ success: true });
  } catch (error) {
    logger.error({ error: error.message }, 'Failed to mark conversation as read');
    res.status(500).json({ error: 'Failed to mark as read' });
  }
});

/**
 * POST /api/messages/conversations/:conversationId/typing
 * Set typing indicator
 */
router.post('/conversations/:conversationId/typing', requireAuth, requireCassandra, async (req, res) => {
  try {
    const userId = req.session.userId;
    const { conversationId } = req.params;

    await setTypingIndicator(conversationId, userId);

    res.json({ success: true });
  } catch (error) {
    logger.error({ error: error.message }, 'Failed to set typing indicator');
    res.status(500).json({ error: 'Failed to set typing indicator' });
  }
});

/**
 * GET /api/messages/conversations/:conversationId/typing
 * Get typing indicators
 */
router.get('/conversations/:conversationId/typing', requireAuth, requireCassandra, async (req, res) => {
  try {
    const { conversationId } = req.params;

    const typingUsers = await getTypingIndicators(conversationId);

    res.json({ typingUsers });
  } catch (error) {
    logger.error({ error: error.message }, 'Failed to get typing indicators');
    res.status(500).json({ error: 'Failed to get typing indicators' });
  }
});

/**
 * POST /api/messages/conversations/:conversationId/messages/:messageId/reactions
 * Add reaction to a message
 */
router.post(
  '/conversations/:conversationId/messages/:messageId/reactions',
  requireAuth,
  requireCassandra,
  async (req, res) => {
    try {
      const userId = req.session.userId;
      const { conversationId, messageId } = req.params;
      const { reaction } = req.body;

      if (!reaction) {
        return res.status(400).json({ error: 'reaction is required' });
      }

      const validReactions = ['heart', 'laugh', 'surprised', 'sad', 'angry', 'thumbs_up'];
      if (!validReactions.includes(reaction)) {
        return res.status(400).json({ error: `Invalid reaction. Must be one of: ${validReactions.join(', ')}` });
      }

      await addReaction(conversationId, messageId, userId, reaction);

      res.status(201).json({ success: true });
    } catch (error) {
      logger.error({ error: error.message }, 'Failed to add reaction');
      res.status(500).json({ error: 'Failed to add reaction' });
    }
  }
);

/**
 * DELETE /api/messages/conversations/:conversationId/messages/:messageId/reactions
 * Remove reaction from a message
 */
router.delete(
  '/conversations/:conversationId/messages/:messageId/reactions',
  requireAuth,
  requireCassandra,
  async (req, res) => {
    try {
      const userId = req.session.userId;
      const { conversationId, messageId } = req.params;

      await removeReaction(conversationId, messageId, userId);

      res.json({ success: true });
    } catch (error) {
      logger.error({ error: error.message }, 'Failed to remove reaction');
      res.status(500).json({ error: 'Failed to remove reaction' });
    }
  }
);

export default router;
