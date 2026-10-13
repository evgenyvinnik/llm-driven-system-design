import { Router, Request, Response } from 'express';
import { authenticateRequest, AuthenticatedRequest } from '../middleware/auth.js';
import { isParticipant, getParticipantIds } from '../services/conversations.js';
import {
  getMessages,
  getMessage,
  sendMessage,
  editMessage,
  deleteMessage,
  addReaction,
  removeReaction,
  markAsRead,
  getReadReceipts,
  getInboxBatch,
  acknowledgeDelivery,
  NotParticipantError,
  IdempotencyConflictError,
  MAX_CONTENT_LENGTH,
} from '../services/messages.js';
import {
  publishNewMessage,
  publishReadReceipt,
  publishReaction,
  publishDeliveryReceipts,
} from '../services/realtime.js';
import { messageRateLimiter } from '../shared/rate-limiter.js';
import { createLogger } from '../shared/logger.js';

const router = Router();
const logger = createLogger('messages-routes');

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Parses an optional non-negative integer query parameter; NaN means invalid. */
function parseSeq(value: unknown): number | undefined {
  if (value === undefined || value === '') return undefined;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : NaN;
}

router.use(authenticateRequest as any);

// Get messages for a conversation, oldest first. Keyset pagination on seq:
// ?before_seq=N pages back through history, ?after_seq=N fills a gap.
router.get('/conversation/:conversationId', async (req: Request, res: Response): Promise<void> => {
  const authReq = req as AuthenticatedRequest;
  try {
    const { conversationId } = req.params;
    const limit = req.query.limit ? parseInt(req.query.limit as string) : 50;
    const beforeSeq = parseSeq(req.query.before_seq);
    const afterSeq = parseSeq(req.query.after_seq);

    if (Number.isNaN(beforeSeq) || Number.isNaN(afterSeq) || Number.isNaN(limit)) {
      res.status(400).json({ error: 'before_seq, after_seq and limit must be non-negative integers' });
      return;
    }

    // Verify user is participant
    const isParticipantResult = await isParticipant(conversationId, authReq.user.id);
    if (!isParticipantResult) {
      res.status(403).json({ error: 'Not a participant of this conversation' });
      return;
    }

    const messages = await getMessages(conversationId, authReq.user.id, { limit, beforeSeq, afterSeq });

    res.json({ messages });
  } catch (error) {
    logger.error({ error, userId: authReq.user?.id }, 'Get messages error');
    res.status(500).json({ error: 'Failed to get messages' });
  }
});

// REST fallback for the device inbox: what this device has not acknowledged yet
router.get('/inbox', async (req: Request, res: Response): Promise<void> => {
  const authReq = req as AuthenticatedRequest;
  try {
    const batch = await getInboxBatch(authReq.deviceId);
    res.json(batch);
  } catch (error) {
    logger.error({ error, userId: authReq.user?.id }, 'Get inbox error');
    res.status(500).json({ error: 'Failed to get inbox' });
  }
});

// Acknowledge inbox messages: deletes their inbox rows and records delivery
router.post('/inbox/ack', async (req: Request, res: Response): Promise<void> => {
  const authReq = req as AuthenticatedRequest;
  try {
    const ids: unknown[] = Array.isArray(req.body?.messageIds) ? req.body.messageIds : [];
    const messageIds = ids.filter((id): id is string => typeof id === 'string' && UUID_PATTERN.test(id)).slice(0, 500);
    const acked = await acknowledgeDelivery(authReq.deviceId, messageIds);
    await publishDeliveryReceipts(authReq.user.id, authReq.deviceId, acked);
    res.json({ acked: acked.length });
  } catch (error) {
    logger.error({ error, userId: authReq.user?.id }, 'Inbox ack error');
    res.status(500).json({ error: 'Failed to acknowledge messages' });
  }
});

// Get a single message
router.get('/:id', async (req: Request, res: Response): Promise<void> => {
  const authReq = req as AuthenticatedRequest;
  try {
    const message = await getMessage(req.params.id);
    if (!message) {
      res.status(404).json({ error: 'Message not found' });
      return;
    }

    // Verify user is participant
    const isParticipantResult = await isParticipant(message.conversation_id, authReq.user.id);
    if (!isParticipantResult) {
      res.status(403).json({ error: 'Not a participant of this conversation' });
      return;
    }

    res.json({ message });
  } catch (error) {
    logger.error({ error, userId: authReq.user?.id }, 'Get message error');
    res.status(500).json({ error: 'Failed to get message' });
  }
});

// Send a message (REST fallback, WebSocket preferred)
// Rate limited: 60 messages per minute per user, shared with the WebSocket path.
// Idempotent: send clientMessageId in the body or an Idempotency-Key header and
// reuse it on retries; a retry returns 200 with the original message.
router.post('/conversation/:conversationId',
  messageRateLimiter,
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    try {
      const { conversationId } = req.params;
      const { content, contentType, replyToId } = req.body;
      const clientMessageId: unknown =
        req.body.clientMessageId ?? req.headers['idempotency-key'] ?? req.headers['x-idempotency-key'];

      if (typeof content !== 'string' || content.trim().length === 0 || content.length > MAX_CONTENT_LENGTH) {
        res.status(400).json({ error: `Content must be 1-${MAX_CONTENT_LENGTH} characters` });
        return;
      }
      if (clientMessageId !== undefined && (typeof clientMessageId !== 'string' || clientMessageId.length > 64)) {
        res.status(400).json({ error: 'clientMessageId must be a string of at most 64 characters' });
        return;
      }
      if (contentType !== undefined && !['text', 'image', 'video', 'file'].includes(contentType)) {
        res.status(400).json({ error: 'Unsupported contentType' });
        return;
      }

      const result = await sendMessage({
        conversationId,
        senderId: authReq.user.id,
        senderDeviceId: authReq.deviceId,
        content,
        contentType,
        replyToId: replyToId ?? null,
        clientMessageId: (clientMessageId as string | undefined) ?? null,
      });

      if (!result.isDuplicate) {
        await publishNewMessage({ message: result.message, participantIds: result.participantIds });
      }

      // Return 200 if duplicate, 201 if new
      res.status(result.isDuplicate ? 200 : 201).json({
        message: result.message,
        isDuplicate: result.isDuplicate,
      });
    } catch (error) {
      if (error instanceof NotParticipantError) {
        res.status(403).json({ error: error.message });
        return;
      }
      if (error instanceof IdempotencyConflictError) {
        res.status(422).json({ error: error.message });
        return;
      }
      logger.error({ error, userId: authReq.user?.id }, 'Send message error');
      res.status(500).json({ error: 'Failed to send message' });
    }
  }
);

// Edit a message
router.patch('/:id', async (req: Request, res: Response): Promise<void> => {
  const authReq = req as AuthenticatedRequest;
  try {
    const { content } = req.body;

    if (!content) {
      res.status(400).json({ error: 'Content is required' });
      return;
    }

    const message = await editMessage(req.params.id, authReq.user.id, content);
    res.json({ message });
  } catch (error) {
    logger.error({ error, userId: authReq.user?.id }, 'Edit message error');
    if ((error as Error).message.includes('not found')) {
      res.status(404).json({ error: (error as Error).message });
      return;
    }
    res.status(500).json({ error: 'Failed to edit message' });
  }
});

// Delete a message
router.delete('/:id', async (req: Request, res: Response): Promise<void> => {
  const authReq = req as AuthenticatedRequest;
  try {
    await deleteMessage(req.params.id, authReq.user.id);
    res.json({ message: 'Message deleted' });
  } catch (error) {
    logger.error({ error, userId: authReq.user?.id }, 'Delete message error');
    if ((error as Error).message.includes('not found')) {
      res.status(404).json({ error: (error as Error).message });
      return;
    }
    res.status(500).json({ error: 'Failed to delete message' });
  }
});

/**
 * Loads a message and checks that the caller participates in its
 * conversation. Without this, any authenticated user could react to any
 * message ID they learned or guessed (and learn which conversation it is in).
 */
async function loadMessageForParticipant(
  req: AuthenticatedRequest,
  res: Response
): Promise<{ conversation_id: string } | null> {
  const message = await getMessage(req.params.id);
  if (!message) {
    res.status(404).json({ error: 'Message not found' });
    return null;
  }
  if (!(await isParticipant(message.conversation_id, req.user.id))) {
    res.status(403).json({ error: 'Not a participant of this conversation' });
    return null;
  }
  return message;
}

// Add reaction
router.post('/:id/reactions', async (req: Request, res: Response): Promise<void> => {
  const authReq = req as AuthenticatedRequest;
  try {
    const { reaction } = req.body;

    if (typeof reaction !== 'string' || reaction.length === 0 || reaction.length > 50) {
      res.status(400).json({ error: 'Reaction is required' });
      return;
    }

    const message = await loadMessageForParticipant(authReq, res);
    if (!message) return;

    const result = await addReaction(req.params.id, authReq.user.id, reaction);
    await publishReaction({
      conversationId: message.conversation_id,
      messageId: req.params.id,
      userId: authReq.user.id,
      reaction,
      remove: false,
      participantIds: await getParticipantIds(message.conversation_id),
    });
    res.status(201).json({ ...result, conversationId: message.conversation_id });
  } catch (error) {
    logger.error({ error, userId: authReq.user?.id }, 'Add reaction error');
    res.status(500).json({ error: 'Failed to add reaction' });
  }
});

// Remove reaction
router.delete('/:id/reactions/:reaction', async (req: Request, res: Response): Promise<void> => {
  const authReq = req as AuthenticatedRequest;
  try {
    const message = await loadMessageForParticipant(authReq, res);
    if (!message) return;

    await removeReaction(req.params.id, authReq.user.id, req.params.reaction);
    await publishReaction({
      conversationId: message.conversation_id,
      messageId: req.params.id,
      userId: authReq.user.id,
      reaction: req.params.reaction,
      remove: true,
      participantIds: await getParticipantIds(message.conversation_id),
    });
    res.json({ message: 'Reaction removed' });
  } catch (error) {
    logger.error({ error, userId: authReq.user?.id }, 'Remove reaction error');
    res.status(500).json({ error: 'Failed to remove reaction' });
  }
});

// Mark as read: advances this device's read watermark (never backwards)
router.post('/conversation/:conversationId/read', async (req: Request, res: Response): Promise<void> => {
  const authReq = req as AuthenticatedRequest;
  try {
    const { conversationId } = req.params;
    const { messageId } = req.body;

    if (typeof messageId !== 'string' || !UUID_PATTERN.test(messageId)) {
      res.status(400).json({ error: 'Message ID is required' });
      return;
    }

    // Verify user is participant
    const isParticipantResult = await isParticipant(conversationId, authReq.user.id);
    if (!isParticipantResult) {
      res.status(403).json({ error: 'Not a participant of this conversation' });
      return;
    }

    const result = await markAsRead(conversationId, authReq.user.id, authReq.deviceId, messageId);
    if (!result) {
      res.status(404).json({ error: 'Message not found in this conversation' });
      return;
    }

    if (result.advanced) {
      await publishReadReceipt({
        conversationId,
        userId: authReq.user.id,
        deviceId: authReq.deviceId,
        seq: result.seq,
        messageId,
        participantIds: await getParticipantIds(conversationId),
      });
    }
    res.json({ message: 'Marked as read', seq: result.seq, advanced: result.advanced });
  } catch (error) {
    logger.error({ error, userId: authReq.user?.id }, 'Mark as read error');
    res.status(500).json({ error: 'Failed to mark as read' });
  }
});

// Get read receipts for a conversation
router.get('/conversation/:conversationId/read-receipts', async (req: Request, res: Response): Promise<void> => {
  const authReq = req as AuthenticatedRequest;
  try {
    const { conversationId } = req.params;

    // Verify user is participant
    const isParticipantResult = await isParticipant(conversationId, authReq.user.id);
    if (!isParticipantResult) {
      res.status(403).json({ error: 'Not a participant of this conversation' });
      return;
    }

    const receipts = await getReadReceipts(conversationId);
    res.json({ receipts });
  } catch (error) {
    logger.error({ error, userId: authReq.user?.id }, 'Get read receipts error');
    res.status(500).json({ error: 'Failed to get read receipts' });
  }
});

export default router;
