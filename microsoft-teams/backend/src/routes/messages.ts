import { Router, Request, Response } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { logger } from '../services/logger.js';
import { messageLimiter } from '../services/rateLimiter.js';
import { messagesTotal } from '../services/metrics.js';
import {
  getChannelMessages,
  getThreadMessages,
  createMessage,
  editMessage,
  deleteMessage,
  withReactionsAndAttachments,
  validateContent,
  clampLimit,
} from '../services/messageService.js';
import { publishToChannel } from '../services/pubsub.js';
import { deleteFile } from '../services/storageService.js';
import {
  AccessError,
  isUuid,
  requireChannel,
  requireMessage,
  respondError,
} from '../services/accessService.js';

const router = Router();

// GET /api/messages?channelId=xxx&before=<messageId>&limit=50 - get channel messages
router.get('/', requireAuth, async (req: Request, res: Response) => {
  try {
    const { channelId, before } = req.query;

    if (!channelId) {
      res.status(400).json({ error: 'channelId query parameter is required' });
      return;
    }
    const channel = await requireChannel(channelId, req.session.userId!);

    if (before !== undefined && !isUuid(before)) {
      throw new AccessError(400, 'before must be the id of a message in this channel');
    }

    const { messages, hasMore } = await getChannelMessages(
      channel.channelId,
      clampLimit(req.query.limit),
      before as string | undefined,
    );

    res.json({ messages: await withReactionsAndAttachments(messages), hasMore });
  } catch (err) {
    respondError(res, err, 'Failed to get messages');
  }
});

// GET /api/messages/:messageId/thread - get thread messages
router.get('/:messageId/thread', requireAuth, async (req: Request, res: Response) => {
  try {
    const { message } = await requireMessage(req.params.messageId, req.session.userId!);
    // Asking for a reply's thread returns the thread it belongs to.
    const rootId = message.parent_message_id ?? message.id;
    const messages = await getThreadMessages(rootId);
    res.json({ messages: await withReactionsAndAttachments(messages) });
  } catch (err) {
    respondError(res, err, 'Failed to get thread');
  }
});

// POST /api/messages - send message
router.post('/', requireAuth, messageLimiter, async (req: Request, res: Response) => {
  try {
    const { id, channelId, content, parentMessageId, fileIds } = req.body;

    if (!channelId) {
      res.status(400).json({ error: 'channelId is required' });
      return;
    }
    if (id !== undefined && !isUuid(id)) throw new AccessError(400, 'id must be a UUID');
    if (parentMessageId !== undefined && parentMessageId !== null && !isUuid(parentMessageId)) {
      throw new AccessError(400, 'Parent message not found in this channel');
    }
    if (fileIds !== undefined && (!Array.isArray(fileIds) || !fileIds.every(isUuid))) {
      throw new AccessError(400, 'fileIds must be an array of file ids');
    }
    const text = validateContent(content, Array.isArray(fileIds) && fileIds.length > 0);

    // Membership is checked on every write, not just on page load.
    const channel = await requireChannel(channelId, req.session.userId!);

    const { message, created } = await createMessage({
      id,
      channelId: channel.channelId,
      userId: req.session.userId!,
      content: text,
      parentMessageId: parentMessageId || undefined,
      fileIds,
    });

    if (created) {
      messagesTotal.inc({ channel_id: channel.channelId });
      // Broadcast via pub/sub only after the transaction committed, and only
      // once — a retried request with the same id is answered from the database.
      await publishToChannel(channel.channelId, 'new_message', message);
    }

    res.status(created ? 201 : 200).json({ message });
  } catch (err) {
    respondError(res, err, 'Failed to send message');
  }
});

// PUT /api/messages/:messageId - edit message
router.put('/:messageId', requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = req.session.userId!;
    const { message: existing } = await requireMessage(req.params.messageId, userId);
    if (existing.deleted_at) throw new AccessError(404, 'Message not found');
    if (existing.user_id !== userId) throw new AccessError(403, 'You can only edit your own messages');

    const content = validateContent(req.body.content);
    const message = await editMessage(existing.id, userId, content);
    if (!message) throw new AccessError(404, 'Message not found');

    // Broadcast edit
    await publishToChannel(message.channel_id, 'message_edited', message);

    res.json({ message });
  } catch (err) {
    respondError(res, err, 'Failed to edit message');
  }
});

// DELETE /api/messages/:messageId - delete message
router.delete('/:messageId', requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = req.session.userId!;
    const { message: existing } = await requireMessage(req.params.messageId, userId);
    if (existing.deleted_at) throw new AccessError(404, 'Message not found');
    if (existing.user_id !== userId) {
      throw new AccessError(403, 'You can only delete your own messages');
    }

    const deleted = await deleteMessage(existing.id, userId);
    if (!deleted) throw new AccessError(404, 'Message not found');

    // Objects are removed after the rows are gone; a failure here only leaves
    // an unreachable object behind, never a row pointing at a missing one.
    for (const path of deleted.storagePaths) {
      deleteFile(path).catch((err) => logger.warn({ err, path }, 'Failed to delete attachment object'));
    }

    await publishToChannel(deleted.message.channel_id, 'message_deleted', deleted.message);

    res.json({ message: 'Message deleted' });
  } catch (err) {
    respondError(res, err, 'Failed to delete message');
  }
});

export default router;
