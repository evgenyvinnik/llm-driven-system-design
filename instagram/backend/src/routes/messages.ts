/**
 * @fileoverview Direct Messages API routes.
 * Handles conversation management, messaging, and real-time features.
 */

import { Router, Request, Response, NextFunction } from 'express';
import { requireAuth, AuthenticatedRequest } from '../middleware/auth.js';
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

// Database row types
interface UserRow {
  id: string;
  username: string;
  profile_picture: string | null;
}

// Valid reaction types
type ReactionType = 'heart' | 'laugh' | 'surprised' | 'sad' | 'angry' | 'thumbs_up';

const validReactions: ReactionType[] = ['heart', 'laugh', 'surprised', 'sad', 'angry', 'thumbs_up'];

/**
 * Check if Cassandra is available middleware
 */
function requireCassandra(req: Request, res: Response, next: NextFunction): void {
  if (!isCassandraConnected()) {
    res.status(503).json({
      error: 'Direct messaging service temporarily unavailable',
    });
    return;
  }
  next();
}

/**
 * GET /api/messages/conversations
 * Get user's inbox (list of conversations)
 */
router.get('/conversations', requireAuth, requireCassandra, async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const userId = req.session.userId!;
    const { limit: limitStr = '20' } = req.query as { limit?: string };
    const limit = parseInt(limitStr);

    const conversations = await getConversations(userId, { limit });

    res.json({ conversations });
  } catch (error) {
    const err = error as Error;
    logger.error({ error: err.message }, 'Failed to get conversations');
    res.status(500).json({ error: 'Failed to get conversations' });
  }
});

interface CreateConversationBody {
  recipientId?: string;
}

/**
 * POST /api/messages/conversations
 * Start a new conversation with a user
 */
router.post('/conversations', requireAuth, requireCassandra, async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const userId = req.session.userId!;
    const { recipientId } = req.body as CreateConversationBody;

    if (!recipientId) {
      res.status(400).json({ error: 'recipientId is required' });
      return;
    }

    if (recipientId === userId) {
      res.status(400).json({ error: 'Cannot message yourself' });
      return;
    }

    // Get user info from PostgreSQL
    const userQuery = 'SELECT id, username, profile_picture FROM users WHERE id = $1';
    const [senderResult, recipientResult] = await Promise.all([
      pool.query<UserRow>(userQuery, [userId]),
      pool.query<UserRow>(userQuery, [recipientId]),
    ]);

    if (senderResult.rowCount === 0) {
      res.status(404).json({ error: 'Sender not found' });
      return;
    }
    if (recipientResult.rowCount === 0) {
      res.status(404).json({ error: 'Recipient not found' });
      return;
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
    const err = error as Error;
    logger.error({ error: err.message }, 'Failed to create conversation');
    res.status(500).json({ error: 'Failed to create conversation' });
  }
});

/**
 * GET /api/messages/conversations/:conversationId
 * Get messages in a conversation
 */
router.get('/conversations/:conversationId', requireAuth, requireCassandra, async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const conversationId = req.params.conversationId as string;
    const { limit: limitStr = '50', before: beforeMessageId } = req.query as { limit?: string; before?: string };
    const limit = parseInt(limitStr);

    const messages = await getMessages(conversationId, { limit, beforeMessageId });

    res.json({ messages });
  } catch (error) {
    const err = error as Error;
    logger.error({ error: err.message, conversationId: req.params.conversationId }, 'Failed to get messages');
    res.status(500).json({ error: 'Failed to get messages' });
  }
});

interface SendMessageBody {
  content?: string;
  contentType?: string;
  mediaUrl?: string;
  replyToMessageId?: string;
}

/**
 * POST /api/messages/conversations/:conversationId
 * Send a message in a conversation
 */
router.post('/conversations/:conversationId', requireAuth, requireCassandra, async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const userId = req.session.userId!;
    const conversationId = req.params.conversationId as string;
    const { content, contentType = 'text', mediaUrl, replyToMessageId } = req.body as SendMessageBody;

    if (!content && !mediaUrl) {
      res.status(400).json({ error: 'content or mediaUrl is required' });
      return;
    }

    const message = await sendMessage({
      conversationId,
      senderId: userId,
      content: content || '',
      contentType: contentType || 'text',
      mediaUrl,
      replyToMessageId,
    });

    res.status(201).json({ message });
  } catch (error) {
    const err = error as Error;
    logger.error({ error: err.message, conversationId: req.params.conversationId }, 'Failed to send message');
    res.status(500).json({ error: 'Failed to send message' });
  }
});

interface MarkReadBody {
  lastMessageId?: string;
}

/**
 * POST /api/messages/conversations/:conversationId/read
 * Mark conversation as read
 */
router.post('/conversations/:conversationId/read', requireAuth, requireCassandra, async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const userId = req.session.userId!;
    const conversationId = req.params.conversationId as string;
    const { lastMessageId } = req.body as MarkReadBody;

    if (!lastMessageId) {
      res.status(400).json({ error: 'lastMessageId is required' });
      return;
    }

    await markConversationRead(conversationId, userId, lastMessageId);

    res.json({ success: true });
  } catch (error) {
    const err = error as Error;
    logger.error({ error: err.message }, 'Failed to mark conversation as read');
    res.status(500).json({ error: 'Failed to mark as read' });
  }
});

/**
 * POST /api/messages/conversations/:conversationId/typing
 * Set typing indicator
 */
router.post('/conversations/:conversationId/typing', requireAuth, requireCassandra, async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const userId = req.session.userId!;
    const conversationId = req.params.conversationId as string;

    await setTypingIndicator(conversationId, userId);

    res.json({ success: true });
  } catch (error) {
    const err = error as Error;
    logger.error({ error: err.message }, 'Failed to set typing indicator');
    res.status(500).json({ error: 'Failed to set typing indicator' });
  }
});

/**
 * GET /api/messages/conversations/:conversationId/typing
 * Get typing indicators
 */
router.get('/conversations/:conversationId/typing', requireAuth, requireCassandra, async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const { conversationId } = req.params;

    const typingUsers = await getTypingIndicators(conversationId);

    res.json({ typingUsers });
  } catch (error) {
    const err = error as Error;
    logger.error({ error: err.message }, 'Failed to get typing indicators');
    res.status(500).json({ error: 'Failed to get typing indicators' });
  }
});

interface AddReactionBody {
  reaction?: string;
}

/**
 * POST /api/messages/conversations/:conversationId/messages/:messageId/reactions
 * Add reaction to a message
 */
router.post(
  '/conversations/:conversationId/messages/:messageId/reactions',
  requireAuth,
  requireCassandra,
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
      const userId = req.session.userId!;
      const { conversationId, messageId } = req.params;
      const { reaction } = req.body as AddReactionBody;

      if (!reaction) {
        res.status(400).json({ error: 'reaction is required' });
        return;
      }

      if (!validReactions.includes(reaction as ReactionType)) {
        res.status(400).json({ error: `Invalid reaction. Must be one of: ${validReactions.join(', ')}` });
        return;
      }

      await addReaction(conversationId, messageId, userId, reaction);

      res.status(201).json({ success: true });
    } catch (error) {
      const err = error as Error;
      logger.error({ error: err.message }, 'Failed to add reaction');
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
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
      const userId = req.session.userId!;
      const { conversationId, messageId } = req.params;

      await removeReaction(conversationId, messageId, userId);

      res.json({ success: true });
    } catch (error) {
      const err = error as Error;
      logger.error({ error: err.message }, 'Failed to remove reaction');
      res.status(500).json({ error: 'Failed to remove reaction' });
    }
  }
);

export default router;
