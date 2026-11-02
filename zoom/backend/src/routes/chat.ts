import { Router, Request, Response } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { logger } from '../services/logger.js';
import * as chatService from '../services/chatService.js';
import { getMeetingForViewer } from '../services/meetingService.js';
import { sendChatMessage } from '../websocket/meetingRooms.js';

const router = Router();

// Chat history for a meeting the caller organized or attended (404 otherwise).
// Direct messages appear only to their sender and recipient.
router.get('/:meetingId/messages', requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = req.session.userId!;
    const meeting = await getMeetingForViewer(req.params.meetingId, userId);
    if (!meeting) {
      res.status(404).json({ error: 'Meeting not found' });
      return;
    }
    const requested = parseInt(req.query.limit as string, 10);
    const limit = Number.isInteger(requested) ? Math.min(Math.max(requested, 1), 500) : 100;
    const messages = await chatService.getMessagesForViewer(meeting.id, userId, limit);
    res.json({ messages });
  } catch (err) {
    logger.error({ err }, 'Get chat messages error');
    res.status(500).json({ error: 'Failed to get messages' });
  }
});

// Send a chat message. Only someone currently in the meeting may post, and the
// message is delivered live exactly as if it came over the socket (the old
// route let anyone write into any meeting and never delivered the message).
router.post('/:meetingId/messages', requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = req.session.userId!;
    const meeting = await getMeetingForViewer(req.params.meetingId, userId);
    if (!meeting) {
      res.status(404).json({ error: 'Meeting not found' });
      return;
    }
    const result = await sendChatMessage(meeting.id, userId, req.body?.content, req.body?.recipientId);
    if (!result.ok) {
      res.status(result.status).json({ error: result.error });
      return;
    }
    res.status(201).json({ message: result.message });
  } catch (err) {
    logger.error({ err }, 'Send chat message error');
    res.status(500).json({ error: 'Failed to send message' });
  }
});

export default router;
