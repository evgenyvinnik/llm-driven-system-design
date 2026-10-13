import { Router, Request, Response } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { requireMessageAccess } from '../middleware/access.js';
import { logger } from '../services/logger.js';
import { addReaction, removeReaction } from '../services/reactionService.js';
import { broadcastChannelEvent } from '../services/sseService.js';

const router = Router();

/** One emoji, possibly with modifiers or joiners; the column is VARCHAR(20). */
function isValidEmoji(emoji: unknown): emoji is string {
  return typeof emoji === 'string' && emoji.length > 0 && emoji.length <= 20;
}

// POST /api/reactions - add reaction. Repeating it is a no-op that emits no event.
router.post(
  '/',
  requireAuth,
  requireMessageAccess((req) => req.body?.messageId),
  async (req: Request, res: Response) => {
    try {
      const { emoji } = req.body;
      const access = req.messageAccess!;

      if (!isValidEmoji(emoji)) {
        res.status(400).json({ error: 'emoji is required' });
        return;
      }
      if (access.deleted) {
        res.status(404).json({ error: 'Message not found' });
        return;
      }

      const event = await addReaction({
        channelId: access.channelId,
        messageId: access.messageId,
        userId: req.session.userId!,
        username: req.session.username!,
        emoji,
      });

      if (!event) {
        res.json({ message: 'Reaction already present', changed: false });
        return;
      }
      void broadcastChannelEvent(event);
      res.status(201).json({ message: 'Reaction added', changed: true });
    } catch (err) {
      logger.error({ err }, 'Failed to add reaction');
      res.status(500).json({ error: 'Internal server error' });
    }
  },
);

// DELETE /api/reactions - remove reaction. Removing one that isn't there emits no event.
router.delete(
  '/',
  requireAuth,
  requireMessageAccess((req) => req.body?.messageId),
  async (req: Request, res: Response) => {
    try {
      const { emoji } = req.body;
      const access = req.messageAccess!;

      if (!isValidEmoji(emoji)) {
        res.status(400).json({ error: 'emoji is required' });
        return;
      }

      const event = await removeReaction({
        channelId: access.channelId,
        messageId: access.messageId,
        userId: req.session.userId!,
        username: req.session.username!,
        emoji,
      });

      if (event) void broadcastChannelEvent(event);
      res.json({ message: event ? 'Reaction removed' : 'Reaction not present', changed: !!event });
    } catch (err) {
      logger.error({ err }, 'Failed to remove reaction');
      res.status(500).json({ error: 'Internal server error' });
    }
  },
);

export default router;
