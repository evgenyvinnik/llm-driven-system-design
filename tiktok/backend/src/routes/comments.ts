import express, { Request, Response, NextFunction, Router } from 'express';
import { query } from '../db.js';
import { requireAuth, optionalAuth, PERMISSIONS, hasPermission } from '../middleware/auth.js';
import { createLogger } from '../shared/logger.js';
import { getRateLimiters } from '../index.js';

const router: Router = express.Router();
const logger = createLogger('comments');

// Comment row type
interface CommentRow {
  id: number;
  user_id: number;
  username: string;
  display_name: string;
  avatar_url: string | null;
  video_id: number;
  parent_id: number | null;
  content: string;
  like_count: number;
  created_at: string;
}

// Helper to get rate limiters
const getLimiters = () => getRateLimiters();

// Helper to format comment response
const formatComment = (comment: CommentRow): Record<string, unknown> => ({
  id: comment.id,
  userId: comment.user_id,
  username: comment.username,
  displayName: comment.display_name,
  avatarUrl: comment.avatar_url,
  videoId: comment.video_id,
  parentId: comment.parent_id,
  content: comment.content,
  likeCount: comment.like_count,
  createdAt: comment.created_at,
});

// Get comments for a video
router.get('/video/:videoId', async (req: Request, res: Response): Promise<void> => {
  try {
    const { videoId } = req.params;
    const limit = Math.min(parseInt(req.query.limit as string) || 20, 100);
    const offset = parseInt(req.query.offset as string) || 0;

    // Get top-level comments
    const result = await query(
      `SELECT c.*, u.username, u.display_name, u.avatar_url
       FROM comments c
       JOIN users u ON c.user_id = u.id
       WHERE c.video_id = $1 AND c.parent_id IS NULL
       ORDER BY c.created_at DESC
       LIMIT $2 OFFSET $3`,
      [videoId, limit, offset]
    );

    // Get reply counts for each comment
    const commentIds = result.rows.map((c: CommentRow) => c.id);
    let replyCounts: Record<number, number> = {};
    if (commentIds.length > 0) {
      const replyResult = await query(
        `SELECT parent_id, COUNT(*) as count
         FROM comments
         WHERE parent_id = ANY($1)
         GROUP BY parent_id`,
        [commentIds]
      );
      replyCounts = Object.fromEntries(
        replyResult.rows.map((r: { parent_id: number; count: string }) => [
          r.parent_id,
          parseInt(r.count),
        ])
      );
    }

    res.json({
      comments: result.rows.map((c: CommentRow) => ({
        ...formatComment(c),
        replyCount: replyCounts[c.id] || 0,
      })),
      hasMore: result.rows.length === limit,
    });
  } catch (error) {
    logger.error({ error: (error as Error).message, videoId: req.params.videoId }, 'Get comments error');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get replies for a comment
router.get('/:commentId/replies', async (req: Request, res: Response): Promise<void> => {
  try {
    const { commentId } = req.params;
    const limit = Math.min(parseInt(req.query.limit as string) || 20, 100);
    const offset = parseInt(req.query.offset as string) || 0;

    const result = await query(
      `SELECT c.*, u.username, u.display_name, u.avatar_url
       FROM comments c
       JOIN users u ON c.user_id = u.id
       WHERE c.parent_id = $1
       ORDER BY c.created_at ASC
       LIMIT $2 OFFSET $3`,
      [commentId, limit, offset]
    );

    res.json({
      replies: result.rows.map((c: CommentRow) => formatComment(c)),
      hasMore: result.rows.length === limit,
    });
  } catch (error) {
    logger.error({ error: (error as Error).message, commentId: req.params.commentId }, 'Get replies error');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Create comment
router.post('/video/:videoId', requireAuth, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  // Apply rate limiting
  const limiters = getLimiters();
  if (limiters?.comment) {
    limiters.comment(req, res, async () => {
      await handleCreateComment(req, res, next);
    });
    return;
  }
  await handleCreateComment(req, res, next);
});

async function handleCreateComment(req: Request, res: Response, _next: NextFunction): Promise<void> {
  try {
    const { videoId } = req.params;
    const { content, parentId } = req.body as { content?: string; parentId?: number };

    if (!content || content.trim().length === 0) {
      res.status(400).json({ error: 'Comment content is required' });
      return;
    }

    if (content.length > 500) {
      res.status(400).json({ error: 'Comment too long (max 500 characters)' });
      return;
    }

    // Check if video exists
    const videoResult = await query(
      'SELECT id FROM videos WHERE id = $1 AND status = $2',
      [videoId, 'active']
    );
    if (videoResult.rows.length === 0) {
      res.status(404).json({ error: 'Video not found' });
      return;
    }

    // If reply, check parent comment exists
    if (parentId) {
      const parentResult = await query(
        'SELECT id FROM comments WHERE id = $1 AND video_id = $2',
        [parentId, videoId]
      );
      if (parentResult.rows.length === 0) {
        res.status(404).json({ error: 'Parent comment not found' });
        return;
      }
    }

    // Create comment
    const result = await query(
      `INSERT INTO comments (user_id, video_id, parent_id, content)
       VALUES ($1, $2, $3, $4)
       RETURNING id, user_id, video_id, parent_id, content, like_count, created_at`,
      [req.session.userId, videoId, parentId || null, content.trim()]
    );

    // Update video comment count
    await query(
      'UPDATE videos SET comment_count = comment_count + 1 WHERE id = $1',
      [videoId]
    );

    // Get user info for response
    const userResult = await query(
      'SELECT username, display_name, avatar_url FROM users WHERE id = $1',
      [req.session.userId]
    );

    const comment = {
      ...(result.rows[0] as CommentRow),
      ...(userResult.rows[0] as { username: string; display_name: string; avatar_url: string | null }),
    };

    logger.debug({
      commentId: comment.id,
      videoId,
      userId: req.session.userId,
      isReply: !!parentId,
    }, 'Comment created');

    res.status(201).json({
      message: 'Comment created successfully',
      comment: formatComment(comment as CommentRow),
    });
  } catch (error) {
    logger.error({ error: (error as Error).message, videoId: req.params.videoId }, 'Create comment error');
    res.status(500).json({ error: 'Internal server error' });
  }
}

// Delete comment
router.delete('/:id', requireAuth, async (req: Request, res: Response): Promise<void> => {
  try {
    const { id } = req.params;

    // Check ownership
    const commentResult = await query(
      'SELECT user_id, video_id FROM comments WHERE id = $1',
      [id]
    );

    if (commentResult.rows.length === 0) {
      res.status(404).json({ error: 'Comment not found' });
      return;
    }

    const comment = commentResult.rows[0] as { user_id: number; video_id: number };
    const isOwner = comment.user_id === req.session.userId;
    const canDeleteAny = hasPermission(req.session.role || 'user', PERMISSIONS.COMMENT_DELETE_ANY);

    if (!isOwner && !canDeleteAny) {
      res.status(403).json({ error: 'Not authorized to delete this comment' });
      return;
    }

    // Count this comment and its replies
    const countResult = await query(
      'SELECT COUNT(*) as count FROM comments WHERE id = $1 OR parent_id = $1',
      [id]
    );
    const deletedCount = parseInt((countResult.rows[0] as { count: string }).count);

    // Delete comment and its replies
    await query('DELETE FROM comments WHERE id = $1 OR parent_id = $1', [id]);

    // Update video comment count
    await query(
      'UPDATE videos SET comment_count = GREATEST(comment_count - $1, 0) WHERE id = $2',
      [deletedCount, comment.video_id]
    );

    logger.debug({
      commentId: id,
      videoId: comment.video_id,
      deletedCount,
      deletedByOwner: isOwner,
    }, 'Comment deleted');

    res.json({ message: 'Comment deleted successfully' });
  } catch (error) {
    logger.error({ error: (error as Error).message, commentId: req.params.id }, 'Delete comment error');
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
