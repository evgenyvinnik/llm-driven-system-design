import express from 'express';
import { castVote, getUserVote } from '../models/vote.js';
import { findPostById } from '../models/post.js';
import { findCommentById } from '../models/comment.js';
import { requireAuth } from '../middleware/auth.js';
import logger from '../shared/logger.js';

const router = express.Router();

// Cast a vote
router.post('/', requireAuth, async (req, res) => {
  try {
    const { type, id, direction } = req.body;

    // Validate type
    if (type !== 'post' && type !== 'comment') {
      return res.status(400).json({ error: 'Type must be "post" or "comment"' });
    }

    // Validate ID
    const targetId = parseInt(id);
    if (isNaN(targetId)) {
      return res.status(400).json({ error: 'Invalid ID' });
    }

    // Validate direction
    if (direction !== 1 && direction !== -1 && direction !== 0) {
      return res.status(400).json({ error: 'Direction must be 1, -1, or 0' });
    }

    // Verify target exists
    if (type === 'post') {
      const post = await findPostById(targetId);
      if (!post) {
        return res.status(404).json({ error: 'Post not found' });
      }
    } else {
      const comment = await findCommentById(targetId);
      if (!comment) {
        return res.status(404).json({ error: 'Comment not found' });
      }
    }

    await castVote(req.user.id, type, targetId, direction);

    // Return updated vote status
    const currentVote = await getUserVote(req.user.id, type, targetId);

    // Get updated score
    let score;
    if (type === 'post') {
      const post = await findPostById(targetId);
      score = post.score;
    } else {
      const comment = await findCommentById(targetId);
      score = comment.score;
    }

    res.json({ success: true, direction: currentVote, score });
  } catch (error) {
    logger.error({ err: error, userId: req.user?.id }, 'Vote error');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get user's vote on a target
router.get('/:type/:id', requireAuth, async (req, res) => {
  try {
    const { type, id } = req.params;

    if (type !== 'post' && type !== 'comment') {
      return res.status(400).json({ error: 'Type must be "post" or "comment"' });
    }

    const targetId = parseInt(id);
    if (isNaN(targetId)) {
      return res.status(400).json({ error: 'Invalid ID' });
    }

    const direction = await getUserVote(req.user.id, type, targetId);
    res.json({ direction });
  } catch (error) {
    logger.error({ err: error, userId: req.user?.id }, 'Get vote error');
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
