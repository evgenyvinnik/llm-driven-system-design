import express from 'express';
import { query } from '../db.js';
import { requireAuth, optionalAuth } from '../middleware/auth.js';

const router = express.Router();

// Helper to format comment response
const formatComment = (comment) => ({
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
router.get('/video/:videoId', async (req, res) => {
  try {
    const { videoId } = req.params;
    const limit = Math.min(parseInt(req.query.limit) || 20, 100);
    const offset = parseInt(req.query.offset) || 0;

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
    const commentIds = result.rows.map(c => c.id);
    let replyCounts = {};
    if (commentIds.length > 0) {
      const replyResult = await query(
        `SELECT parent_id, COUNT(*) as count
         FROM comments
         WHERE parent_id = ANY($1)
         GROUP BY parent_id`,
        [commentIds]
      );
      replyCounts = Object.fromEntries(
        replyResult.rows.map(r => [r.parent_id, parseInt(r.count)])
      );
    }

    res.json({
      comments: result.rows.map(c => ({
        ...formatComment(c),
        replyCount: replyCounts[c.id] || 0,
      })),
      hasMore: result.rows.length === limit,
    });
  } catch (error) {
    console.error('Get comments error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get replies for a comment
router.get('/:commentId/replies', async (req, res) => {
  try {
    const { commentId } = req.params;
    const limit = Math.min(parseInt(req.query.limit) || 20, 100);
    const offset = parseInt(req.query.offset) || 0;

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
      replies: result.rows.map(formatComment),
      hasMore: result.rows.length === limit,
    });
  } catch (error) {
    console.error('Get replies error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Create comment
router.post('/video/:videoId', requireAuth, async (req, res) => {
  try {
    const { videoId } = req.params;
    const { content, parentId } = req.body;

    if (!content || content.trim().length === 0) {
      return res.status(400).json({ error: 'Comment content is required' });
    }

    if (content.length > 500) {
      return res.status(400).json({ error: 'Comment too long (max 500 characters)' });
    }

    // Check if video exists
    const videoResult = await query(
      'SELECT id FROM videos WHERE id = $1 AND status = $2',
      [videoId, 'active']
    );
    if (videoResult.rows.length === 0) {
      return res.status(404).json({ error: 'Video not found' });
    }

    // If reply, check parent comment exists
    if (parentId) {
      const parentResult = await query(
        'SELECT id FROM comments WHERE id = $1 AND video_id = $2',
        [parentId, videoId]
      );
      if (parentResult.rows.length === 0) {
        return res.status(404).json({ error: 'Parent comment not found' });
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
      ...result.rows[0],
      ...userResult.rows[0],
    };

    res.status(201).json({
      message: 'Comment created successfully',
      comment: formatComment(comment),
    });
  } catch (error) {
    console.error('Create comment error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Delete comment
router.delete('/:id', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;

    // Check ownership
    const commentResult = await query(
      'SELECT user_id, video_id FROM comments WHERE id = $1',
      [id]
    );

    if (commentResult.rows.length === 0) {
      return res.status(404).json({ error: 'Comment not found' });
    }

    if (commentResult.rows[0].user_id !== req.session.userId && req.session.role !== 'admin') {
      return res.status(403).json({ error: 'Not authorized to delete this comment' });
    }

    // Count this comment and its replies
    const countResult = await query(
      'SELECT COUNT(*) as count FROM comments WHERE id = $1 OR parent_id = $1',
      [id]
    );
    const deletedCount = parseInt(countResult.rows[0].count);

    // Delete comment and its replies
    await query('DELETE FROM comments WHERE id = $1 OR parent_id = $1', [id]);

    // Update video comment count
    await query(
      'UPDATE videos SET comment_count = GREATEST(comment_count - $1, 0) WHERE id = $2',
      [deletedCount, commentResult.rows[0].video_id]
    );

    res.json({ message: 'Comment deleted successfully' });
  } catch (error) {
    console.error('Delete comment error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
