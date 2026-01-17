import { Router } from 'express';
import { query } from '../services/db.js';
import { requireAuth, optionalAuth } from '../middleware/auth.js';

const router = Router();

// Get comments for a post
router.get('/posts/:postId/comments', async (req, res) => {
  try {
    const { postId } = req.params;
    const { cursor, limit = 20 } = req.query;

    let queryText = `
      SELECT c.*, u.username, u.display_name, u.profile_picture_url
      FROM comments c
      JOIN users u ON c.user_id = u.id
      WHERE c.post_id = $1 AND c.parent_comment_id IS NULL
    `;
    const params = [postId];

    if (cursor) {
      queryText += ` AND c.created_at < $${params.length + 1}`;
      params.push(cursor);
    }

    queryText += ` ORDER BY c.created_at DESC LIMIT $${params.length + 1}`;
    params.push(parseInt(limit) + 1);

    const result = await query(queryText, params);

    const hasMore = result.rows.length > limit;
    const comments = result.rows.slice(0, limit);

    res.json({
      comments: comments.map((c) => ({
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
    console.error('Get comments error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Add comment to post
router.post('/posts/:postId/comments', requireAuth, async (req, res) => {
  try {
    const { postId } = req.params;
    const { content, parentCommentId } = req.body;
    const userId = req.session.userId;

    if (!content || content.trim().length === 0) {
      return res.status(400).json({ error: 'Comment content is required' });
    }

    // Verify post exists
    const postCheck = await query('SELECT id FROM posts WHERE id = $1', [postId]);
    if (postCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Post not found' });
    }

    // If replying, verify parent comment exists
    if (parentCommentId) {
      const parentCheck = await query(
        'SELECT id FROM comments WHERE id = $1 AND post_id = $2',
        [parentCommentId, postId]
      );
      if (parentCheck.rows.length === 0) {
        return res.status(404).json({ error: 'Parent comment not found' });
      }
    }

    const result = await query(
      `INSERT INTO comments (user_id, post_id, content, parent_comment_id)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [userId, postId, content.trim(), parentCommentId || null]
    );

    const comment = result.rows[0];

    // Get user info
    const userResult = await query(
      'SELECT username, display_name, profile_picture_url FROM users WHERE id = $1',
      [userId]
    );
    const user = userResult.rows[0];

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
    console.error('Add comment error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Delete comment
router.delete('/comments/:commentId', requireAuth, async (req, res) => {
  try {
    const { commentId } = req.params;
    const userId = req.session.userId;

    // Check ownership
    const commentCheck = await query('SELECT user_id, post_id FROM comments WHERE id = $1', [commentId]);
    if (commentCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Comment not found' });
    }

    const comment = commentCheck.rows[0];

    // Check if user owns comment or post
    const postCheck = await query('SELECT user_id FROM posts WHERE id = $1', [comment.post_id]);
    const isCommentOwner = comment.user_id === userId;
    const isPostOwner = postCheck.rows[0]?.user_id === userId;
    const isAdmin = req.session.role === 'admin';

    if (!isCommentOwner && !isPostOwner && !isAdmin) {
      return res.status(403).json({ error: 'Not authorized' });
    }

    await query('DELETE FROM comments WHERE id = $1', [commentId]);

    res.json({ message: 'Comment deleted' });
  } catch (error) {
    console.error('Delete comment error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Like comment
router.post('/comments/:commentId/like', requireAuth, async (req, res) => {
  try {
    const { commentId } = req.params;
    const userId = req.session.userId;

    await query(
      'INSERT INTO comment_likes (user_id, comment_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [userId, commentId]
    );

    // Update like count
    await query('UPDATE comments SET like_count = like_count + 1 WHERE id = $1', [commentId]);

    res.json({ message: 'Comment liked' });
  } catch (error) {
    console.error('Like comment error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Unlike comment
router.delete('/comments/:commentId/like', requireAuth, async (req, res) => {
  try {
    const { commentId } = req.params;
    const userId = req.session.userId;

    const result = await query(
      'DELETE FROM comment_likes WHERE user_id = $1 AND comment_id = $2 RETURNING id',
      [userId, commentId]
    );

    if (result.rows.length > 0) {
      await query('UPDATE comments SET like_count = like_count - 1 WHERE id = $1', [commentId]);
    }

    res.json({ message: 'Comment unliked' });
  } catch (error) {
    console.error('Unlike comment error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get replies to a comment
router.get('/comments/:commentId/replies', async (req, res) => {
  try {
    const { commentId } = req.params;
    const { cursor, limit = 10 } = req.query;

    let queryText = `
      SELECT c.*, u.username, u.display_name, u.profile_picture_url
      FROM comments c
      JOIN users u ON c.user_id = u.id
      WHERE c.parent_comment_id = $1
    `;
    const params = [commentId];

    if (cursor) {
      queryText += ` AND c.created_at > $${params.length + 1}`;
      params.push(cursor);
    }

    queryText += ` ORDER BY c.created_at ASC LIMIT $${params.length + 1}`;
    params.push(parseInt(limit) + 1);

    const result = await query(queryText, params);

    const hasMore = result.rows.length > limit;
    const replies = result.rows.slice(0, limit);

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
    console.error('Get replies error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
