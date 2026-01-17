/**
 * Feed routes for the LinkedIn clone.
 * Handles post creation, feed generation with ranking,
 * and engagement features (likes, comments).
 *
 * @module routes/feed
 */
import { Router, Request, Response } from 'express';
import * as feedService from '../services/feedService.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();

// Get feed
router.get('/', requireAuth, async (req: Request, res: Response) => {
  try {
    const offset = parseInt(req.query.offset as string) || 0;
    const limit = parseInt(req.query.limit as string) || 20;

    const posts = await feedService.getFeed(req.session.userId!, offset, limit);
    res.json({ posts });
  } catch (error) {
    console.error('Get feed error:', error);
    res.status(500).json({ error: 'Failed to get feed' });
  }
});

// Create post
router.post('/', requireAuth, async (req: Request, res: Response) => {
  try {
    const { content, imageUrl } = req.body;

    if (!content) {
      res.status(400).json({ error: 'Content required' });
      return;
    }

    const post = await feedService.createPost(req.session.userId!, content, imageUrl);
    res.status(201).json({ post });
  } catch (error) {
    console.error('Create post error:', error);
    res.status(500).json({ error: 'Failed to create post' });
  }
});

// Get single post
router.get('/:id', async (req: Request, res: Response) => {
  try {
    const post = await feedService.getPostById(parseInt(req.params.id));
    if (!post) {
      res.status(404).json({ error: 'Post not found' });
      return;
    }
    res.json({ post });
  } catch (error) {
    console.error('Get post error:', error);
    res.status(500).json({ error: 'Failed to get post' });
  }
});

// Update post
router.patch('/:id', requireAuth, async (req: Request, res: Response) => {
  try {
    const { content, imageUrl } = req.body;

    if (!content) {
      res.status(400).json({ error: 'Content required' });
      return;
    }

    const post = await feedService.updatePost(
      parseInt(req.params.id),
      req.session.userId!,
      content,
      imageUrl
    );

    if (!post) {
      res.status(404).json({ error: 'Post not found or not authorized' });
      return;
    }

    res.json({ post });
  } catch (error) {
    console.error('Update post error:', error);
    res.status(500).json({ error: 'Failed to update post' });
  }
});

// Delete post
router.delete('/:id', requireAuth, async (req: Request, res: Response) => {
  try {
    const deleted = await feedService.deletePost(parseInt(req.params.id), req.session.userId!);
    if (!deleted) {
      res.status(404).json({ error: 'Post not found or not authorized' });
      return;
    }
    res.json({ message: 'Post deleted' });
  } catch (error) {
    console.error('Delete post error:', error);
    res.status(500).json({ error: 'Failed to delete post' });
  }
});

// Like post
router.post('/:id/like', requireAuth, async (req: Request, res: Response) => {
  try {
    await feedService.likePost(req.session.userId!, parseInt(req.params.id));
    res.json({ message: 'Post liked' });
  } catch (error) {
    console.error('Like post error:', error);
    res.status(500).json({ error: 'Failed to like post' });
  }
});

// Unlike post
router.delete('/:id/like', requireAuth, async (req: Request, res: Response) => {
  try {
    await feedService.unlikePost(req.session.userId!, parseInt(req.params.id));
    res.json({ message: 'Post unliked' });
  } catch (error) {
    console.error('Unlike post error:', error);
    res.status(500).json({ error: 'Failed to unlike post' });
  }
});

// Get post likes
router.get('/:id/likes', async (req: Request, res: Response) => {
  try {
    const users = await feedService.getPostLikes(parseInt(req.params.id));
    res.json({ users });
  } catch (error) {
    console.error('Get likes error:', error);
    res.status(500).json({ error: 'Failed to get likes' });
  }
});

// Get post comments
router.get('/:id/comments', async (req: Request, res: Response) => {
  try {
    const offset = parseInt(req.query.offset as string) || 0;
    const limit = parseInt(req.query.limit as string) || 50;

    const comments = await feedService.getPostComments(parseInt(req.params.id), offset, limit);
    res.json({ comments });
  } catch (error) {
    console.error('Get comments error:', error);
    res.status(500).json({ error: 'Failed to get comments' });
  }
});

// Add comment
router.post('/:id/comments', requireAuth, async (req: Request, res: Response) => {
  try {
    const { content } = req.body;

    if (!content) {
      res.status(400).json({ error: 'Content required' });
      return;
    }

    const comment = await feedService.addComment(
      parseInt(req.params.id),
      req.session.userId!,
      content
    );

    res.status(201).json({ comment });
  } catch (error) {
    console.error('Add comment error:', error);
    res.status(500).json({ error: 'Failed to add comment' });
  }
});

// Delete comment
router.delete('/comments/:id', requireAuth, async (req: Request, res: Response) => {
  try {
    const deleted = await feedService.deleteComment(parseInt(req.params.id), req.session.userId!);
    if (!deleted) {
      res.status(404).json({ error: 'Comment not found or not authorized' });
      return;
    }
    res.json({ message: 'Comment deleted' });
  } catch (error) {
    console.error('Delete comment error:', error);
    res.status(500).json({ error: 'Failed to delete comment' });
  }
});

// Get user posts
router.get('/user/:userId', async (req: Request, res: Response) => {
  try {
    const offset = parseInt(req.query.offset as string) || 0;
    const limit = parseInt(req.query.limit as string) || 20;

    const posts = await feedService.getUserPosts(parseInt(req.params.userId), offset, limit);
    res.json({ posts });
  } catch (error) {
    console.error('Get user posts error:', error);
    res.status(500).json({ error: 'Failed to get user posts' });
  }
});

export default router;
