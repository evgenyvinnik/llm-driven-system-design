import { Router, Request, Response } from 'express';
import { MatchService } from '../services/matchService.js';
import { MessageService } from '../services/messageService.js';
import { requireAuth } from '../middleware/auth.js';

/**
 * Match and messaging routes.
 * Handles match list, conversation messages, read receipts, and unmatching.
 * All routes require authentication.
 */
const router = Router();
const matchService = new MatchService();
const messageService = new MessageService();

/**
 * GET /api/matches
 * Returns all matches for the authenticated user with unread message counts.
 * Ordered by most recent activity (last message or match time).
 */
router.get('/', requireAuth, async (req: Request, res: Response) => {
  try {
    const matches = await matchService.getUserMatches(req.session.userId!);

    // Get unread counts
    const unreadCounts = await messageService.getUnreadCountByMatch(req.session.userId!);

    const matchesWithUnread = matches.map((match) => ({
      ...match,
      unread_count: unreadCounts.get(match.id) || 0,
    }));

    res.json(matchesWithUnread);
  } catch (error) {
    console.error('Get matches error:', error);
    res.status(500).json({ error: 'Failed to get matches' });
  }
});

/**
 * GET /api/matches/:matchId/messages
 * Returns paginated messages for a match conversation.
 * Automatically marks retrieved messages as read.
 */
router.get('/:matchId/messages', requireAuth, async (req: Request, res: Response) => {
  try {
    const { matchId } = req.params;
    const limit = Math.min(parseInt(req.query.limit as string) || 50, 100);
    const before = req.query.before as string | undefined;

    const messages = await messageService.getMessages(
      matchId,
      req.session.userId!,
      limit,
      before
    );

    res.json(messages);
  } catch (error) {
    console.error('Get messages error:', error);
    res.status(500).json({ error: 'Failed to get messages' });
  }
});

/**
 * POST /api/matches/:matchId/messages
 * Sends a new message in a match conversation.
 * Validates content length (max 5000 chars) and publishes via WebSocket.
 */
router.post('/:matchId/messages', requireAuth, async (req: Request, res: Response) => {
  try {
    const { matchId } = req.params;
    const { content } = req.body;

    if (!content || typeof content !== 'string' || content.trim().length === 0) {
      res.status(400).json({ error: 'Message content required' });
      return;
    }

    if (content.length > 5000) {
      res.status(400).json({ error: 'Message too long' });
      return;
    }

    const message = await messageService.sendMessage(
      matchId,
      req.session.userId!,
      content.trim()
    );

    if (!message) {
      res.status(403).json({ error: 'Not authorized to send message in this conversation' });
      return;
    }

    res.status(201).json(message);
  } catch (error) {
    console.error('Send message error:', error);
    res.status(500).json({ error: 'Failed to send message' });
  }
});

/**
 * POST /api/matches/:matchId/read
 * Marks all unread messages in a match as read by the authenticated user.
 */
router.post('/:matchId/read', requireAuth, async (req: Request, res: Response) => {
  try {
    const { matchId } = req.params;
    await messageService.markAsRead(matchId, req.session.userId!);
    res.json({ success: true });
  } catch (error) {
    console.error('Mark read error:', error);
    res.status(500).json({ error: 'Failed to mark as read' });
  }
});

/**
 * DELETE /api/matches/:matchId
 * Removes a match between two users.
 * Deletes match record, all messages, and swipe history.
 */
router.delete('/:matchId', requireAuth, async (req: Request, res: Response) => {
  try {
    const { matchId } = req.params;
    const success = await matchService.unmatch(matchId, req.session.userId!);

    if (!success) {
      res.status(403).json({ error: 'Not authorized to unmatch' });
      return;
    }

    res.json({ message: 'Unmatched successfully' });
  } catch (error) {
    console.error('Unmatch error:', error);
    res.status(500).json({ error: 'Failed to unmatch' });
  }
});

/**
 * GET /api/matches/unread/count
 * Returns total unread message count across all matches.
 * Used for notification badge display.
 */
router.get('/unread/count', requireAuth, async (req: Request, res: Response) => {
  try {
    const count = await messageService.getUnreadCount(req.session.userId!);
    res.json({ count });
  } catch (error) {
    console.error('Get unread count error:', error);
    res.status(500).json({ error: 'Failed to get unread count' });
  }
});

export default router;
