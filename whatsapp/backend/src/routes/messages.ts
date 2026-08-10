import { Router, Request, Response } from 'express';
import {
  getMessagesForConversation,
  markConversationAsRead,
} from '../services/messageService.js';
import {
  addReaction,
  removeReaction,
  getReactionsForMessage,
  getMessageConversationId,
  isValidEmoji,
  getAllowedEmojis,
  getReactionsForConversation,
} from '../services/reactionService.js';
import { isUserInConversation } from '../services/conversationService.js';
import { requireAuth } from '../middleware/auth.js';
import { broadcastReactionUpdate } from '../websocket/index.js';

/**
 * Message routes.
 * Handles fetching messages and marking conversations as read.
 * Message sending happens via WebSocket for real-time delivery.
 */
const router = Router();

/**
 * GET /api/messages/:conversationId
 * Returns messages for a conversation with pagination.
 * Supports cursor-based pagination via 'before' query param.
 */
router.get('/:conversationId', requireAuth, async (req: Request, res: Response) => {
  try {
    const conversationId = req.params.conversationId;
    const limit = parseInt(req.query.limit as string) || 50;
    const beforeId = req.query.before as string | undefined;

    const isParticipant = await isUserInConversation(req.session.userId!, conversationId);
    if (!isParticipant) {
      return res.status(403).json({ error: 'Not a participant in this conversation' });
    }

    const messages = await getMessagesForConversation(conversationId, limit, beforeId);

    res.json({ messages });
  } catch (error) {
    console.error('Get messages error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /api/messages/:conversationId/read
 * Marks all messages in a conversation as read.
 * Returns the IDs of messages that were marked as read.
 */
router.post('/:conversationId/read', requireAuth, async (req: Request, res: Response) => {
  try {
    const conversationId = req.params.conversationId;

    const isParticipant = await isUserInConversation(req.session.userId!, conversationId);
    if (!isParticipant) {
      return res.status(403).json({ error: 'Not a participant in this conversation' });
    }

    const messageIds = await markConversationAsRead(conversationId, req.session.userId!);

    res.json({ messageIds });
  } catch (error) {
    console.error('Mark read error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/messages/:conversationId/reactions
 * Returns every message's reaction summaries for a conversation, keyed by
 * message ID. Must be declared before the `/:messageId/reactions` route below,
 * or Express matches "reactions" as a message ID.
 */
router.get('/:conversationId/reactions', requireAuth, async (req: Request, res: Response) => {
  try {
    const { conversationId } = req.params;

    const isParticipant = await isUserInConversation(req.session.userId!, conversationId);
    if (!isParticipant) {
      return res.status(403).json({ error: 'Not a participant in this conversation' });
    }

    const reactions = await getReactionsForConversation(conversationId, req.session.userId!);
    res.json({ reactions, allowedEmojis: getAllowedEmojis() });
  } catch (error) {
    console.error('Get conversation reactions error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/messages/:conversationId/:messageId/reactions
 * Returns reaction summaries for a specific message.
 */
router.get('/:conversationId/:messageId/reactions', requireAuth, async (req: Request, res: Response) => {
  try {
    const { conversationId, messageId } = req.params;

    const isParticipant = await isUserInConversation(req.session.userId!, conversationId);
    if (!isParticipant) {
      return res.status(403).json({ error: 'Not a participant in this conversation' });
    }

    const reactions = await getReactionsForMessage(messageId, req.session.userId!);
    res.json({ reactions, allowedEmojis: getAllowedEmojis() });
  } catch (error) {
    console.error('Get reactions error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /api/messages/:conversationId/:messageId/reactions
 * Adds a reaction to a message.
 * Body: { emoji: string }
 */
router.post('/:conversationId/:messageId/reactions', requireAuth, async (req: Request, res: Response) => {
  try {
    const { conversationId, messageId } = req.params;
    const { emoji } = req.body;

    if (!emoji || typeof emoji !== 'string') {
      return res.status(400).json({ error: 'Emoji is required' });
    }

    if (!isValidEmoji(emoji)) {
      return res.status(400).json({
        error: 'Invalid emoji',
        allowedEmojis: getAllowedEmojis(),
      });
    }

    const isParticipant = await isUserInConversation(req.session.userId!, conversationId);
    if (!isParticipant) {
      return res.status(403).json({ error: 'Not a participant in this conversation' });
    }

    // Verify message belongs to conversation
    const msgConversationId = await getMessageConversationId(messageId);
    if (msgConversationId !== conversationId) {
      return res.status(404).json({ error: 'Message not found in this conversation' });
    }

    const reaction = await addReaction(messageId, req.session.userId!, emoji);

    if (!reaction) {
      return res.status(409).json({ error: 'Reaction already exists or invalid emoji' });
    }

    // Get updated reaction summaries
    const reactions = await getReactionsForMessage(messageId, req.session.userId!);

    // Broadcast reaction update to all participants via WebSocket
    await broadcastReactionUpdate(conversationId, messageId, reactions, req.session.userId!);

    res.status(201).json({ reaction, reactions });
  } catch (error) {
    console.error('Add reaction error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * DELETE /api/messages/:conversationId/:messageId/reactions/:emoji
 * Removes a reaction from a message.
 */
router.delete('/:conversationId/:messageId/reactions/:emoji', requireAuth, async (req: Request, res: Response) => {
  try {
    const { conversationId, messageId, emoji } = req.params;
    const decodedEmoji = decodeURIComponent(emoji);

    const isParticipant = await isUserInConversation(req.session.userId!, conversationId);
    if (!isParticipant) {
      return res.status(403).json({ error: 'Not a participant in this conversation' });
    }

    // Verify message belongs to conversation
    const msgConversationId = await getMessageConversationId(messageId);
    if (msgConversationId !== conversationId) {
      return res.status(404).json({ error: 'Message not found in this conversation' });
    }

    const removed = await removeReaction(messageId, req.session.userId!, decodedEmoji);

    if (!removed) {
      return res.status(404).json({ error: 'Reaction not found' });
    }

    // Get updated reaction summaries
    const reactions = await getReactionsForMessage(messageId, req.session.userId!);

    // Broadcast reaction update to all participants via WebSocket
    await broadcastReactionUpdate(conversationId, messageId, reactions, req.session.userId!);

    res.json({ success: true, reactions });
  } catch (error) {
    console.error('Remove reaction error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
