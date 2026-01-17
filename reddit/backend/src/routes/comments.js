import express from 'express';
import { createComment, findCommentById, getCommentSubtree } from '../models/comment.js';
import { findPostById } from '../models/post.js';
import { requireAuth } from '../middleware/auth.js';

const router = express.Router();

// Create comment on post
router.post('/posts/:postId/comments', requireAuth, async (req, res) => {
  try {
    const postId = parseInt(req.params.postId);
    if (isNaN(postId)) {
      return res.status(400).json({ error: 'Invalid post ID' });
    }

    const { content, parentId } = req.body;

    if (!content || !content.trim()) {
      return res.status(400).json({ error: 'Comment content is required' });
    }

    const post = await findPostById(postId);
    if (!post) {
      return res.status(404).json({ error: 'Post not found' });
    }

    // Validate parent comment if provided
    if (parentId) {
      const parentComment = await findCommentById(parentId);
      if (!parentComment || parentComment.post_id !== postId) {
        return res.status(400).json({ error: 'Invalid parent comment' });
      }
    }

    const comment = await createComment(postId, req.user.id, content.trim(), parentId || null);

    res.status(201).json({
      ...comment,
      author_username: req.user.username,
      replies: [],
    });
  } catch (error) {
    console.error('Create comment error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get comment and its subtree
router.get('/comments/:id', async (req, res) => {
  try {
    const commentId = parseInt(req.params.id);
    if (isNaN(commentId)) {
      return res.status(400).json({ error: 'Invalid comment ID' });
    }

    const tree = await getCommentSubtree(commentId);
    if (!tree) {
      return res.status(404).json({ error: 'Comment not found' });
    }

    res.json(tree);
  } catch (error) {
    console.error('Get comment error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
