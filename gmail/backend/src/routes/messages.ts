import { Router, Request, Response } from 'express';
import { requireAuth, AuthenticatedRequest } from '../middleware/auth.js';
import { sendMessage, SendError } from '../services/messageService.js';
import { sendRateLimiter } from '../services/rateLimiter.js';
import logger from '../services/logger.js';
import { isUuid } from '../services/validation.js';

const router = Router();

/**
 * POST /api/v1/messages/send
 * Send a new email
 */
router.post(
  '/send',
  requireAuth as unknown as import('express').RequestHandler,
  sendRateLimiter,
  async (req: Request, res: Response) => {
    try {
      const authReq = req as AuthenticatedRequest;
      const senderId = authReq.session.userId!;
      const { to, cc, bcc, subject, bodyText, bodyHtml, threadId, inReplyTo } =
        req.body;

      if (!to || !Array.isArray(to) || to.length === 0) {
        return res
          .status(400)
          .json({ error: 'At least one recipient is required' });
      }

      if (!subject && !threadId) {
        return res.status(400).json({ error: 'Subject is required for new threads' });
      }

      if (!bodyText) {
        return res.status(400).json({ error: 'Message body is required' });
      }
      if ((threadId !== undefined && threadId !== null && !isUuid(threadId)) ||
          (inReplyTo !== undefined && inReplyTo !== null && !isUuid(inReplyTo))) {
        return res.status(404).json({ error: 'Thread not found' });
      }

      const result = await sendMessage(senderId, {
        to,
        cc,
        bcc,
        subject: subject || '',
        bodyText,
        bodyHtml,
        threadId,
        inReplyTo,
      });

      res.status(201).json(result);
    } catch (error) {
      if (error instanceof SendError) {
        return res.status(error.status).json({ error: error.message, ...error.details });
      }
      const err = error as Error;
      logger.error({ error: err.message }, 'Failed to send message');
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

/**
 * POST /api/v1/messages/reply
 * Reply to an existing thread
 */
router.post(
  '/reply',
  requireAuth as unknown as import('express').RequestHandler,
  sendRateLimiter,
  async (req: Request, res: Response) => {
    try {
      const authReq = req as AuthenticatedRequest;
      const senderId = authReq.session.userId!;
      const { threadId, inReplyTo, to, cc, bcc, bodyText, bodyHtml } = req.body;

      if (!threadId) {
        return res.status(400).json({ error: 'Thread ID is required for reply' });
      }

      if (!to || !Array.isArray(to) || to.length === 0) {
        return res
          .status(400)
          .json({ error: 'At least one recipient is required' });
      }

      if (!bodyText) {
        return res.status(400).json({ error: 'Message body is required' });
      }
      if ((threadId !== undefined && threadId !== null && !isUuid(threadId)) ||
          (inReplyTo !== undefined && inReplyTo !== null && !isUuid(inReplyTo))) {
        return res.status(404).json({ error: 'Thread not found' });
      }

      const result = await sendMessage(senderId, {
        to,
        cc,
        bcc,
        subject: '',
        bodyText,
        bodyHtml,
        threadId,
        inReplyTo,
      });

      res.status(201).json(result);
    } catch (error) {
      if (error instanceof SendError) {
        return res.status(error.status).json({ error: error.message, ...error.details });
      }
      const err = error as Error;
      logger.error({ error: err.message }, 'Failed to send reply');
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

export default router;
