import { Router, Request, Response } from 'express';
import { pool } from '../services/db.js';
import { requireAuth } from '../middleware/auth.js';
import { publishToChannel } from '../services/pubsub.js';
import { AccessError, requireMessage, respondError } from '../services/accessService.js';

const router = Router();

/** Validates the body and checks the caller can see the (live) message. */
async function resolveTarget(req: Request) {
  const { messageId, emoji } = req.body;
  if (!messageId || !emoji) throw new AccessError(400, 'messageId and emoji are required');
  // emoji is VARCHAR(20); a longer value used to surface as a 500.
  if (typeof emoji !== 'string' || [...emoji].length > 20) {
    throw new AccessError(400, 'emoji must be a short string');
  }
  const { message } = await requireMessage(messageId, req.session.userId!);
  if (message.deleted_at) throw new AccessError(404, 'Message not found');
  return { message, emoji };
}

// POST /api/reactions - add reaction
router.post('/', requireAuth, async (req: Request, res: Response) => {
  try {
    const { message, emoji } = await resolveTarget(req);

    const result = await pool.query(
      `INSERT INTO message_reactions (message_id, user_id, emoji)
       VALUES ($1, $2, $3)
       ON CONFLICT (message_id, user_id, emoji) DO NOTHING
       RETURNING id`,
      [message.id, req.session.userId, emoji],
    );

    // Broadcast only when a row was actually added. Clients increment the
    // count on every reaction_added, so re-adding an existing reaction used to
    // inflate everyone's counter even though the database didn't change.
    if (result.rows.length > 0) {
      await publishToChannel(message.channel_id, 'reaction_added', {
        messageId: message.id,
        emoji,
        userId: req.session.userId,
        username: req.session.username,
      });
    }

    res.status(result.rows.length > 0 ? 201 : 200).json({ message: 'Reaction added' });
  } catch (err) {
    respondError(res, err, 'Failed to add reaction');
  }
});

// DELETE /api/reactions - remove reaction
router.delete('/', requireAuth, async (req: Request, res: Response) => {
  try {
    const { message, emoji } = await resolveTarget(req);

    const result = await pool.query(
      `DELETE FROM message_reactions
       WHERE message_id = $1 AND user_id = $2 AND emoji = $3
       RETURNING id`,
      [message.id, req.session.userId, emoji],
    );

    if (result.rows.length > 0) {
      await publishToChannel(message.channel_id, 'reaction_removed', {
        messageId: message.id,
        emoji,
        userId: req.session.userId,
        username: req.session.username,
      });
    }

    res.json({ message: 'Reaction removed' });
  } catch (err) {
    respondError(res, err, 'Failed to remove reaction');
  }
});

export default router;
