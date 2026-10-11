import { Router, Request, Response } from 'express';
import { pool } from '../services/db.js';
import { requireAuth } from '../middleware/auth.js';
import { logger } from '../services/logger.js';
import { requireVideoAccess, isUuid } from '../services/videoAccess.js';

const router = Router();

const MAX_COMMENT_LENGTH = 5000;

// GET /api/videos/:videoId/comments - List comments for a video (owner or share viewer)
router.get('/:videoId/comments', requireVideoAccess('viewer'), async (req: Request, res: Response) => {
  try {
    const { videoId } = req.params;

    const result = await pool.query(
      `SELECT c.*, u.username, u.display_name, u.avatar_url
       FROM comments c
       JOIN users u ON u.id = c.user_id
       WHERE c.video_id = $1
       ORDER BY c.created_at ASC`,
      [videoId],
    );

    const comments = result.rows.map((row) => ({
      id: row.id,
      videoId: row.video_id,
      userId: row.user_id,
      content: row.content,
      timestampSeconds: row.timestamp_seconds,
      parentId: row.parent_id,
      createdAt: row.created_at,
      author: {
        username: row.username,
        displayName: row.display_name,
        avatarUrl: row.avatar_url,
      },
    }));

    res.json({ comments });
  } catch (err) {
    logger.error({ err }, 'Failed to list comments');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/videos/:videoId/comments - Create a comment (signed in, and able to watch the video)
router.post(
  '/:videoId/comments',
  requireAuth,
  requireVideoAccess('viewer'),
  async (req: Request, res: Response) => {
    try {
      const { videoId } = req.params;
      const { content, timestampSeconds, parentId } = req.body ?? {};
      const userId = req.session.userId;
      const video = res.locals.videoAccess!.video;

      if (typeof content !== 'string' || content.trim().length === 0) {
        res.status(400).json({ error: 'Content is required' });
        return;
      }
      if (content.length > MAX_COMMENT_LENGTH) {
        res.status(400).json({ error: `Comments are limited to ${MAX_COMMENT_LENGTH} characters` });
        return;
      }

      // An anchor has to point inside the recording (with a second of slack for rounding).
      if (timestampSeconds !== undefined && timestampSeconds !== null) {
        const duration = video.duration_seconds as number | null;
        if (
          typeof timestampSeconds !== 'number' ||
          !Number.isFinite(timestampSeconds) ||
          timestampSeconds < 0 ||
          (duration !== null && timestampSeconds > duration + 1)
        ) {
          res.status(400).json({ error: 'timestampSeconds must fall within the video' });
          return;
        }
      }

      // Replies are one level deep: the parent must be a top-level comment on this video.
      if (parentId) {
        if (!isUuid(parentId)) {
          res.status(404).json({ error: 'Parent comment not found' });
          return;
        }
        const parent = await pool.query(
          'SELECT parent_id FROM comments WHERE id = $1 AND video_id = $2',
          [parentId, videoId],
        );
        if (parent.rows.length === 0) {
          res.status(404).json({ error: 'Parent comment not found' });
          return;
        }
        if (parent.rows[0].parent_id) {
          res.status(400).json({ error: 'Replies can only be added to top-level comments' });
          return;
        }
      }

      const result = await pool.query(
        `INSERT INTO comments (video_id, user_id, content, timestamp_seconds, parent_id)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING *`,
        [videoId, userId, content.trim(), timestampSeconds ?? null, parentId || null],
      );

      // Fetch author info
      const user = await pool.query(
        'SELECT username, display_name, avatar_url FROM users WHERE id = $1',
        [userId],
      );

      const comment = result.rows[0];
      res.status(201).json({
        comment: {
          id: comment.id,
          videoId: comment.video_id,
          userId: comment.user_id,
          content: comment.content,
          timestampSeconds: comment.timestamp_seconds,
          parentId: comment.parent_id,
          createdAt: comment.created_at,
          author: {
            username: user.rows[0].username,
            displayName: user.rows[0].display_name,
            avatarUrl: user.rows[0].avatar_url,
          },
        },
      });
    } catch (err) {
      logger.error({ err }, 'Failed to create comment');
      res.status(500).json({ error: 'Internal server error' });
    }
  },
);

// DELETE /api/videos/:videoId/comments/:commentId - The author, or the video's owner, may delete
router.delete('/:videoId/comments/:commentId', requireAuth, async (req: Request, res: Response) => {
  try {
    const { videoId, commentId } = req.params;
    const userId = req.session.userId;
    if (!isUuid(videoId) || !isUuid(commentId)) {
      res.status(404).json({ error: 'Comment not found' });
      return;
    }

    const result = await pool.query(
      `DELETE FROM comments c
       USING videos v
       WHERE c.id = $1 AND c.video_id = $2 AND v.id = c.video_id
         AND (c.user_id = $3 OR v.user_id = $3)
       RETURNING c.id`,
      [commentId, videoId, userId],
    );

    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Comment not found' });
      return;
    }

    res.json({ message: 'Comment deleted' });
  } catch (err) {
    logger.error({ err }, 'Failed to delete comment');
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
