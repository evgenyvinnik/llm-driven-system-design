/**
 * @fileoverview Post management routes for CRUD operations and engagement.
 * Handles post creation with automatic fan-out, likes, comments, and deletion.
 * Integrates with affinity scoring to improve future feed personalization.
 * Includes idempotency protection for post creation and comprehensive metrics.
 */

import { Router, Request, Response } from 'express';
import { pool, redis } from '../db/connection.js';
import { authMiddleware, optionalAuthMiddleware } from '../middleware/auth.js';
import { fanoutPost, removeFanout, updateAffinity, calculatePostScore } from '../services/fanout.js';
import {
  componentLoggers,
  postsCreatedTotal,
  postLikesTotal,
  commentsCreatedTotal,
  requireIdempotency,
} from '../shared/index.js';
import type { CreatePostRequest, PostWithAuthor } from '../types/index.js';

const log = componentLoggers.posts;

/** Express router for post endpoints */
const router = Router();

/**
 * POST / - Creates a new post and distributes it to followers' feeds.
 * Triggers fan-out service to push post to followers (for non-celebrities)
 * or store in celebrity post cache (for celebrities).
 * Protected by idempotency middleware to prevent duplicate posts.
 */
router.post('/', authMiddleware, requireIdempotency(), async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const { content, image_url, post_type = 'text', privacy = 'public' } = req.body as CreatePostRequest;

    if (!content && !image_url) {
      res.status(400).json({ error: 'Content or image is required' });
      return;
    }

    // Create post
    const result = await pool.query(
      `INSERT INTO posts (author_id, content, image_url, post_type, privacy)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [userId, content, image_url || null, post_type, privacy]
    );

    const post = result.rows[0];

    // Record metrics
    postsCreatedTotal.labels(post_type, privacy).inc();

    log.info(
      { postId: post.id, authorId: userId, postType: post_type, privacy },
      'Post created'
    );

    // Fan out to followers
    await fanoutPost(post.id, userId, post.created_at);

    // Get author info
    const authorResult = await pool.query(
      `SELECT id, username, display_name, avatar_url, is_celebrity
       FROM users WHERE id = $1`,
      [userId]
    );

    const response: PostWithAuthor = {
      ...post,
      author: authorResult.rows[0],
      is_liked: false,
    };

    res.status(201).json(response);
  } catch (error) {
    log.error({ error }, 'Create post error');
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /:postId - Retrieves a single post by ID with author info.
 * Respects privacy settings and updates affinity score for views.
 * Returns is_liked status for authenticated users.
 */
router.get('/:postId', optionalAuthMiddleware, async (req: Request, res: Response) => {
  try {
    const { postId } = req.params;

    const result = await pool.query(
      `SELECT p.*, u.id as author_id, u.username as author_username,
              u.display_name as author_display_name, u.avatar_url as author_avatar_url,
              u.is_celebrity as author_is_celebrity
       FROM posts p
       JOIN users u ON p.author_id = u.id
       WHERE p.id = $1 AND p.is_deleted = false`,
      [postId]
    );

    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Post not found' });
      return;
    }

    const post = result.rows[0];

    // Check privacy
    if (post.privacy === 'friends' && req.user?.id !== post.author_id) {
      const friendshipResult = await pool.query(
        `SELECT id FROM friendships
         WHERE follower_id = $1 AND following_id = $2 AND status = 'active'`,
        [req.user?.id, post.author_id]
      );

      if (friendshipResult.rows.length === 0 && !req.user) {
        res.status(403).json({ error: 'This post is only visible to friends' });
        return;
      }
    }

    // Check if user liked the post
    let isLiked = false;
    if (req.user) {
      const likeResult = await pool.query(
        'SELECT id FROM likes WHERE user_id = $1 AND post_id = $2',
        [req.user.id, postId]
      );
      isLiked = likeResult.rows.length > 0;

      // Update affinity for viewing
      await updateAffinity(req.user.id, post.author_id, 'view');
    }

    res.json({
      id: post.id,
      content: post.content,
      image_url: post.image_url,
      post_type: post.post_type,
      privacy: post.privacy,
      like_count: post.like_count,
      comment_count: post.comment_count,
      share_count: post.share_count,
      created_at: post.created_at,
      updated_at: post.updated_at,
      is_liked: isLiked,
      author: {
        id: post.author_id,
        username: post.author_username,
        display_name: post.author_display_name,
        avatar_url: post.author_avatar_url,
        is_celebrity: post.author_is_celebrity,
      },
    });
  } catch (error) {
    log.error({ error, postId: req.params.postId }, 'Get post error');
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * DELETE /:postId - Soft-deletes a post and removes it from all feeds.
 * Only the post author or admin can delete a post.
 * Triggers fan-out removal to clean up followers' feeds.
 */
router.delete('/:postId', authMiddleware, async (req: Request, res: Response) => {
  const postId = req.params.postId as string;

  try {
    const userId = req.user!.id;

    // Check ownership
    const postResult = await pool.query(
      'SELECT author_id FROM posts WHERE id = $1',
      [postId]
    );

    if (postResult.rows.length === 0) {
      res.status(404).json({ error: 'Post not found' });
      return;
    }

    if (postResult.rows[0].author_id !== userId && req.user!.role !== 'admin') {
      res.status(403).json({ error: 'Not authorized to delete this post' });
      return;
    }

    // Soft delete
    await pool.query(
      'UPDATE posts SET is_deleted = true WHERE id = $1',
      [postId]
    );

    // Remove from feeds
    await removeFanout(postId, postResult.rows[0].author_id);

    res.json({ message: 'Post deleted successfully' });
  } catch (error) {
    log.error({ error, postId }, 'Delete post error');
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /:postId/like - Adds a like to a post.
 * Updates affinity score between liker and post author.
 * Caches like in Redis for fast lookup and atomic count updates.
 */
router.post('/:postId/like', authMiddleware, async (req: Request, res: Response) => {
  try {
    const { postId } = req.params;
    const userId = req.user!.id;

    // Check if post exists
    const postResult = await pool.query(
      'SELECT author_id FROM posts WHERE id = $1 AND is_deleted = false',
      [postId]
    );

    if (postResult.rows.length === 0) {
      res.status(404).json({ error: 'Post not found' });
      return;
    }

    // Check if already liked
    const existingLike = await pool.query(
      'SELECT id FROM likes WHERE user_id = $1 AND post_id = $2',
      [userId, postId]
    );

    if (existingLike.rows.length > 0) {
      res.status(409).json({ error: 'Already liked this post' });
      return;
    }

    // Create like
    await pool.query(
      'INSERT INTO likes (user_id, post_id) VALUES ($1, $2)',
      [userId, postId]
    );

    // Update like count
    await pool.query(
      'UPDATE posts SET like_count = like_count + 1 WHERE id = $1',
      [postId]
    );

    // Update affinity
    await updateAffinity(userId, postResult.rows[0].author_id, 'like');

    // Cache like in Redis
    await redis.sadd(`post_likes:${postId}`, userId);
    await redis.incr(`like_count:${postId}`);

    // Record metrics
    postLikesTotal.labels('like').inc();

    log.info({ postId, userId }, 'Post liked');

    res.json({ message: 'Post liked successfully' });
  } catch (error) {
    log.error({ error, postId: req.params.postId }, 'Like post error');
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * DELETE /:postId/like - Removes a like from a post.
 * Updates Redis cache and decrements like count.
 * Does not affect affinity score (interactions are additive only).
 */
router.delete('/:postId/like', authMiddleware, async (req: Request, res: Response) => {
  try {
    const { postId } = req.params;
    const userId = req.user!.id;

    // Delete like
    const result = await pool.query(
      'DELETE FROM likes WHERE user_id = $1 AND post_id = $2 RETURNING id',
      [userId, postId]
    );

    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Like not found' });
      return;
    }

    // Update like count
    await pool.query(
      'UPDATE posts SET like_count = GREATEST(like_count - 1, 0) WHERE id = $1',
      [postId]
    );

    // Update Redis cache
    await redis.srem(`post_likes:${postId}`, userId);
    await redis.decr(`like_count:${postId}`);

    // Record metrics
    postLikesTotal.labels('unlike').inc();

    res.json({ message: 'Post unliked successfully' });
  } catch (error) {
    log.error({ error, postId: req.params.postId }, 'Unlike post error');
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /:postId/comments - Retrieves comments for a post with author info.
 * Returns paginated list ordered by creation time (oldest first).
 * Uses offset-based pagination for simplicity.
 */
router.get('/:postId/comments', optionalAuthMiddleware, async (req: Request, res: Response) => {
  try {
    const { postId } = req.params;
    const limit = parseInt(req.query.limit as string) || 20;
    const offset = parseInt(req.query.offset as string) || 0;

    // Check if post exists
    const postExists = await pool.query(
      'SELECT id FROM posts WHERE id = $1 AND is_deleted = false',
      [postId]
    );

    if (postExists.rows.length === 0) {
      res.status(404).json({ error: 'Post not found' });
      return;
    }

    const result = await pool.query(
      `SELECT c.*, u.id as author_id, u.username as author_username,
              u.display_name as author_display_name, u.avatar_url as author_avatar_url
       FROM comments c
       JOIN users u ON c.user_id = u.id
       WHERE c.post_id = $1
       ORDER BY c.created_at ASC
       LIMIT $2 OFFSET $3`,
      [postId, limit, offset]
    );

    const comments = result.rows.map((c: {
      id: string;
      content: string;
      like_count: number;
      created_at: Date;
      author_id: string;
      author_username: string;
      author_display_name: string;
      author_avatar_url: string | null;
    }) => ({
      id: c.id,
      content: c.content,
      like_count: c.like_count,
      created_at: c.created_at,
      author: {
        id: c.author_id,
        username: c.author_username,
        display_name: c.author_display_name,
        avatar_url: c.author_avatar_url,
      },
    }));

    res.json({
      comments,
      has_more: result.rows.length === limit,
    });
  } catch (error) {
    log.error({ error, postId: req.params.postId }, 'Get comments error');
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /:postId/comments - Adds a comment to a post.
 * Updates comment count and affinity score with post author.
 * Returns the created comment with author info.
 */
router.post('/:postId/comments', authMiddleware, async (req: Request, res: Response) => {
  try {
    const { postId } = req.params;
    const userId = req.user!.id;
    const { content } = req.body;

    if (!content || content.trim().length === 0) {
      res.status(400).json({ error: 'Comment content is required' });
      return;
    }

    // Check if post exists
    const postResult = await pool.query(
      'SELECT author_id FROM posts WHERE id = $1 AND is_deleted = false',
      [postId]
    );

    if (postResult.rows.length === 0) {
      res.status(404).json({ error: 'Post not found' });
      return;
    }

    // Create comment
    const result = await pool.query(
      `INSERT INTO comments (user_id, post_id, content)
       VALUES ($1, $2, $3)
       RETURNING *`,
      [userId, postId, content.trim()]
    );

    // Update comment count
    await pool.query(
      'UPDATE posts SET comment_count = comment_count + 1 WHERE id = $1',
      [postId]
    );

    // Update affinity
    await updateAffinity(userId, postResult.rows[0].author_id, 'comment');

    // Get author info
    const authorResult = await pool.query(
      'SELECT id, username, display_name, avatar_url FROM users WHERE id = $1',
      [userId]
    );

    // Record metrics
    commentsCreatedTotal.inc();

    log.info({ postId, commentId: result.rows[0].id, userId }, 'Comment created');

    res.status(201).json({
      ...result.rows[0],
      author: authorResult.rows[0],
    });
  } catch (error) {
    log.error({ error, postId: req.params.postId }, 'Create comment error');
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * DELETE /:postId/comments/:commentId - Deletes a comment from a post.
 * Only the comment author or admin can delete a comment.
 * Decrements the post's comment count.
 */
router.delete('/:postId/comments/:commentId', authMiddleware, async (req: Request, res: Response) => {
  try {
    const { postId, commentId } = req.params;
    const userId = req.user!.id;

    // Check ownership
    const commentResult = await pool.query(
      'SELECT user_id FROM comments WHERE id = $1 AND post_id = $2',
      [commentId, postId]
    );

    if (commentResult.rows.length === 0) {
      res.status(404).json({ error: 'Comment not found' });
      return;
    }

    if (commentResult.rows[0].user_id !== userId && req.user!.role !== 'admin') {
      res.status(403).json({ error: 'Not authorized to delete this comment' });
      return;
    }

    // Delete comment
    await pool.query('DELETE FROM comments WHERE id = $1', [commentId]);

    // Update comment count
    await pool.query(
      'UPDATE posts SET comment_count = GREATEST(comment_count - 1, 0) WHERE id = $1',
      [postId]
    );

    log.info({ postId, commentId, userId }, 'Comment deleted');

    res.json({ message: 'Comment deleted successfully' });
  } catch (error) {
    log.error({ error, postId: req.params.postId, commentId: req.params.commentId }, 'Delete comment error');
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
