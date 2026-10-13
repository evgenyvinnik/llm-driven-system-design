import { Router, Request, Response } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { requireChannelAccess, requireMessageAccess } from '../middleware/access.js';
import { isUuid } from '../services/access.js';
import { logger } from '../services/logger.js';
import { messageLimiter } from '../services/rateLimiter.js';
import { messagesTotal, messageSendReplaysTotal } from '../services/metrics.js';
import {
  getChannelHistory,
  getThreadMessages,
  createMessage,
  editMessage,
  deleteMessage,
} from '../services/messageService.js';
import { broadcastChannelEvent } from '../services/sseService.js';

const router = Router();

const MAX_CONTENT_LENGTH = 10000;
const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;

/** Positive integer query value: undefined when absent, null when malformed. */
function parsePositiveInt(value: unknown): number | undefined | null {
  if (value === undefined || value === '') return undefined;
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function isValidContent(content: unknown): content is string {
  return (
    typeof content === 'string' &&
    content.trim().length > 0 &&
    content.length <= MAX_CONTENT_LENGTH
  );
}

// GET /api/messages?channelId=xxx&before=<seq>&limit=50 - one page of history, newest first.
// `before` is the seq of the oldest message the client already has; `latestSeq` in the response
// is where the client's event stream should start (GET /api/sse/:channelId?after=latestSeq).
router.get(
  '/',
  requireAuth,
  requireChannelAccess((req) => req.query.channelId),
  async (req: Request, res: Response) => {
    try {
      const before = parsePositiveInt(req.query.before);
      const limit = parsePositiveInt(req.query.limit);
      if (before === null || limit === null) {
        res.status(400).json({ error: 'before and limit must be positive integers' });
        return;
      }

      const page = await getChannelHistory(req.channelAccess!.channelId, {
        before,
        limit: Math.min(limit ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE),
      });
      res.json(page);
    } catch (err) {
      logger.error({ err }, 'Failed to get messages');
      res.status(500).json({ error: 'Internal server error' });
    }
  },
);

// GET /api/messages/:messageId/thread - a thread's root and replies (from any message in it)
router.get(
  '/:messageId/thread',
  requireAuth,
  requireMessageAccess((req) => req.params.messageId),
  async (req: Request, res: Response) => {
    try {
      const access = req.messageAccess!;
      const messages = await getThreadMessages(access.parentMessageId ?? access.messageId);
      res.json({ messages });
    } catch (err) {
      logger.error({ err }, 'Failed to get thread');
      res.status(500).json({ error: 'Internal server error' });
    }
  },
);

// POST /api/messages - send a message or thread reply. clientMessageId is a UUID the client
// generates once per message and reuses on every retry; a repeat returns the original message
// (200 + Idempotent-Replayed) instead of posting it twice.
router.post(
  '/',
  requireAuth,
  messageLimiter,
  requireChannelAccess((req) => req.body?.channelId),
  async (req: Request, res: Response) => {
    try {
      const { content, parentMessageId, clientMessageId } = req.body;

      if (!isValidContent(content)) {
        res
          .status(400)
          .json({ error: `content is required (max ${MAX_CONTENT_LENGTH} characters)` });
        return;
      }
      if (parentMessageId != null && !isUuid(parentMessageId)) {
        res.status(400).json({ error: 'parentMessageId must be a UUID' });
        return;
      }
      if (clientMessageId != null && !isUuid(clientMessageId)) {
        res.status(400).json({ error: 'clientMessageId must be a UUID' });
        return;
      }

      const result = await createMessage({
        channelId: req.channelAccess!.channelId,
        userId: req.session.userId!,
        content,
        parentMessageId: parentMessageId ?? null,
        clientMessageId: clientMessageId ?? null,
      });

      switch (result.kind) {
        case 'invalid_parent':
          res
            .status(400)
            .json({ error: 'parentMessageId must be a top-level message in this channel' });
          return;
        case 'key_conflict':
          res
            .status(422)
            .json({ error: 'clientMessageId was already used for a different message' });
          return;
        case 'replayed':
          messageSendReplaysTotal.inc();
          res.set('Idempotent-Replayed', 'true').status(200).json({ message: result.message });
          return;
        case 'created':
          messagesTotal.inc();
          // Fire and forget: the event is committed, and delivery never fails the request.
          void broadcastChannelEvent(result.event);
          res.status(201).json({ message: result.message });
          return;
      }
    } catch (err) {
      logger.error({ err }, 'Failed to send message');
      res.status(500).json({ error: 'Internal server error' });
    }
  },
);

// PUT /api/messages/:messageId - edit own message
router.put(
  '/:messageId',
  requireAuth,
  requireMessageAccess((req) => req.params.messageId),
  async (req: Request, res: Response) => {
    try {
      const { content } = req.body;

      if (!isValidContent(content)) {
        res
          .status(400)
          .json({ error: `content is required (max ${MAX_CONTENT_LENGTH} characters)` });
        return;
      }

      const access = req.messageAccess!;
      const result = await editMessage(
        access.channelId,
        access.messageId,
        req.session.userId!,
        content,
      );

      if (!result) {
        res.status(404).json({ error: 'Message not found or not yours' });
        return;
      }

      void broadcastChannelEvent(result.event);
      res.json({ message: result.message });
    } catch (err) {
      logger.error({ err }, 'Failed to edit message');
      res.status(500).json({ error: 'Internal server error' });
    }
  },
);

// DELETE /api/messages/:messageId - delete own message (kept as a tombstone)
router.delete(
  '/:messageId',
  requireAuth,
  requireMessageAccess((req) => req.params.messageId),
  async (req: Request, res: Response) => {
    try {
      const access = req.messageAccess!;
      const event = await deleteMessage(access.channelId, access.messageId, req.session.userId!);

      if (!event) {
        res.status(404).json({ error: 'Message not found or not yours' });
        return;
      }

      void broadcastChannelEvent(event);
      res.json({ message: 'Message deleted' });
    } catch (err) {
      logger.error({ err }, 'Failed to delete message');
      res.status(500).json({ error: 'Internal server error' });
    }
  },
);

export default router;
