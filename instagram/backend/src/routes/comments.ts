import { Router, Request, Response, RequestHandler } from 'express';
import { query } from '../services/db.js';
import { requireAuth, optionalAuth, AuthenticatedRequest } from '../middleware/auth.js';
import { commentRateLimiter } from '../services/rateLimiter.js';
import logger from '../services/logger.js';

const router = Router();

interface CommentRow {
  id: string;
  user_id: string;
  post_id: string;
  parent_comment_id: string | null;
  username: string;
  display_name: string;
  profile_picture_url: string | null;
  content: string;
  like_count: number;
  created_at: Date;
}

interface PostOwnerRow {
  user_id: string;
}

// Get comments for a post
router.get('/posts/:postId/comments', async (req: Request, res: Response): Promise<void> => {
  try {
    const { postId } = req.params;
    const { cursor, limit = '20' } = req.query as { cursor?: string; limit?: string };
    const limitNum = parseInt(limit, 10);

    let queryText = `
      SELECT c.*, u.username, u.display_name, u.profile_picture_url
      FROM comments c
      JOIN users u ON c.user_id = u.id
      WHERE c.post_id = $1 AND c.parent_comment_id IS NULL
    `;
    const params: unknown[] = [postId];

    if (cursor) {
      queryText += ` AND c.created_at < $${params.length + 1}`;
      params.push(cursor);
    }

    queryText += ` ORDER BY c.created_at DESC LIMIT $${params.length + 1}`;
    params.push(limitNum + 1);

    const result = await query<CommentRow>(queryText, params);

    const hasMore = result.rows.length > limitNum;
    const comments = result.rows.slice(0, limitNum);

    res.json({
      comments: comments.map((c: CommentRow) => ({
        id: c.id,
        userId: c.user_id,
        username: c.username,
        displayName: c.display_name,
        profilePictureUrl: c.profile_picture_url,
        content: c.content,
        likeCount: c.like_count,
        createdAt: c.created_at,
      })),
      nextCursor: hasMore ? comments[comments.length - 1].created_at : null,
    });
  } catch (error) {
    const err = error as Error;
    logger.error(
      {
        type: 'get_comments_error',
        error: err.message,
        postId: req.params.postId,
      },
      `Get comments error: ${err.message}`
    );
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Add comment to post - with rate limiting
router.post(
  '/posts/:postId/comments',
  requireAuth as RequestHandler,
  commentRateLimiter,
  async (req: Request, res: Response): Promise<void> => {
    try {
      const { postId } = req.params;
      const { content, parentCommentId } = req.body as { content?: string; parentCommentId?: string };
      const authReq = req as AuthenticatedRequest;
      const userId = authReq.session.userId!;

      if (!content || content.trim().length === 0) {
        res.status(400).json({ error: 'Comment content is required' });
        return;
      }

      // Verify post exists
      const postCheck = await query<{ id: string }>('SELECT id FROM posts WHERE id = $1', [postId]);
      if (postCheck.rows.length === 0) {
        res.status(404).json({ error: 'Post not found' });
        return;
      }

      // If replying, verify parent comment exists
      if (parentCommentId) {
        const parentCheck = await query<{ id: string }>('SELECT id FROM comments WHERE id = $1 AND post_id = $2', [
          parentCommentId,
          postId,
        ]);
        if (parentCheck.rows.length === 0) {
          res.status(404).json({ error: 'Parent comment not found' });
          return;
        }
      }

      const result = await query<CommentRow>(
        `INSERT INTO comments (user_id, post_id, content, parent_comment_id)
         VALUES ($1, $2, $3, $4)
         RETURNING *`,
        [userId, postId, content.trim(), parentCommentId || null]
      );

      const comment = result.rows[0];

      // Get user info
      const userResult = await query<{ username: string; display_name: string; profile_picture_url: string | null }>(
        'SELECT username, display_name, profile_picture_url FROM users WHERE id = $1',
        [userId]
      );
      const user = userResult.rows[0];

      logger.info(
        {
          type: 'comment_created',
          commentId: comment.id,
          postId,
          userId,
          isReply: !!parentCommentId,
        },
        `Comment created: ${comment.id}`
      );

      res.status(201).json({
        comment: {
          id: comment.id,
          userId: comment.user_id,
          username: user.username,
          displayName: user.display_name,
          profilePictureUrl: user.profile_picture_url,
          content: comment.content,
          parentCommentId: comment.parent_comment_id,
          likeCount: comment.like_count,
          createdAt: comment.created_at,
        },
      });
    } catch (error) {
      const err = error as Error;
      logger.error(
        {
          type: 'add_comment_error',
          error: err.message,
          postId: req.params.postId,
        },
        `Add comment error: ${err.message}`
      );
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// Delete comment
router.delete('/comments/:commentId', requireAuth as RequestHandler, async (req: Request, res: Response): Promise<void> => {
  try {
    const { commentId } = req.params;
    const authReq = req as AuthenticatedRequest;
    const userId = authReq.session.userId!;

    // Check ownership
    const commentCheck = await query<{ user_id: string; post_id: string }>(
      'SELECT user_id, post_id FROM comments WHERE id = $1',
      [commentId]
    );
    if (commentCheck.rows.length === 0) {
      res.status(404).json({ error: 'Comment not found' });
      return;
    }

    const comment = commentCheck.rows[0];

    // Check if user owns comment or post
    const postCheck = await query<PostOwnerRow>('SELECT user_id FROM posts WHERE id = $1', [comment.post_id]);
    const isCommentOwner = comment.user_id === userId;
    const isPostOwner = postCheck.rows[0]?.user_id === userId;
    const isAdmin = authReq.session.role === 'admin';

    if (!isCommentOwner && !isPostOwner && !isAdmin) {
      res.status(403).json({ error: 'Not authorized' });
      return;
    }

    await query('DELETE FROM comments WHERE id = $1', [commentId]);

    logger.info(
      {
        type: 'comment_deleted',
        commentId,
        userId,
        deletedBy: isCommentOwner ? 'owner' : isPostOwner ? 'post_owner' : 'admin',
      },
      `Comment deleted: ${commentId}`
    );

    res.json({ message: 'Comment deleted' });
  } catch (error) {
    const err = error as Error;
    logger.error(
      {
        type: 'delete_comment_error',
        error: err.message,
        commentId: req.params.commentId,
      },
      `Delete comment error: ${err.message}`
    );
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Like comment - idempotent operation
router.post('/comments/:commentId/like', requireAuth as RequestHandler, async (req: Request, res: Response): Promise<void> => {
  try {
    const { commentId } = req.params;
    const authReq = req as AuthenticatedRequest;
    const userId = authReq.session.userId!;

    // Insert like - idempotent with ON CONFLICT
    const result = await query<{ id: string }>(
      'INSERT INTO comment_likes (user_id, comment_id) VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING id',
      [userId, commentId]
    );

    if (result.rows.length > 0) {
      // New like - update count
      await query('UPDATE comments SET like_count = like_count + 1 WHERE id = $1', [commentId]);
    }

    res.json({ message: 'Comment liked', idempotent: result.rows.length === 0 });
  } catch (error) {
    const err = error as Error;
    logger.error(
      {
        type: 'like_comment_error',
        error: err.message,
        commentId: req.params.commentId,
      },
      `Like comment error: ${err.message}`
    );
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Unlike comment - idempotent operation
router.delete('/comments/:commentId/like', requireAuth as express.RequestHandler, async (req: Request, res: Response): Promise<void> => {
  try {
    const { commentId } = req.params;
    const authReq = req as AuthenticatedRequest;
    const userId = authReq.session.userId!;

    const result = await query<{ id: string }>(
      'DELETE FROM comment_likes WHERE user_id = $1 AND comment_id = $2 RETURNING id',
      [userId, commentId]
    );

    if (result.rows.length > 0) {
      await query('UPDATE comments SET like_count = like_count - 1 WHERE id = $1', [commentId]);
    }

    res.json({ message: 'Comment unliked', idempotent: result.rows.length === 0 });
  } catch (error) {
    const err = error as Error;
    logger.error(
      {
        type: 'unlike_comment_error',
        error: err.message,
        commentId: req.params.commentId,
      },
      `Unlike comment error: ${err.message}`
    );
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get replies to a comment
router.get('/comments/:commentId/replies', async (req: Request, res: Response): Promise<void> => {
  try {
    const { commentId } = req.params;
    const { cursor, limit = '10' } = req.query as { cursor?: string; limit?: string };
    const limitNum = parseInt(limit, 10);

    let queryText = `
      SELECT c.*, u.username, u.display_name, u.profile_picture_url
      FROM comments c
      JOIN users u ON c.user_id = u.id
      WHERE c.parent_comment_id = $1
    `;
    const params: unknown[] = [commentId];

    if (cursor) {
      queryText += ` AND c.created_at > $${params.length + 1}`;
      params.push(cursor);
    }

    queryText += ` ORDER BY c.created_at ASC LIMIT $${params.length + 1}`;
    params.push(limitNum + 1);

    const result = await query<CommentRow>(queryText, params);

    const hasMore = result.rows.length > limitNum;
    const replies = result.rows.slice(0, limitNum);

    res.json({
      replies: replies.map((c) => ({
        id: c.id,
        userId: c.user_id,
        username: c.username,
        displayName: c.display_name,
        profilePictureUrl: c.profile_picture_url,
        content: c.content,
        likeCount: c.like_count,
        createdAt: c.created_at,
      })),
      nextCursor: hasMore ? replies[replies.length - 1].created_at : null,
    });
  } catch (error) {
    const err = error as Error;
    logger.error(
      {
        type: 'get_replies_error',
        error: err.message,
        commentId: req.params.commentId,
      },
      `Get replies error: ${err.message}`
    );
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
