import express from 'express';
import { createPost, findPostById, listAllPosts } from '../models/post.js';
import { listCommentsByPost } from '../models/comment.js';
import { findSubredditByName } from '../models/subreddit.js';
import { getUserVote, getUserVotesForPosts, getUserVotesForComments } from '../models/vote.js';
import { requireAuth } from '../middleware/auth.js';
import logger from '../shared/logger.js';

const router = express.Router();

// Get all posts (home feed)
router.get('/', async (req, res) => {
  try {
    const sort = req.query.sort || 'hot';
    const limit = Math.min(parseInt(req.query.limit) || 25, 100);
    const offset = parseInt(req.query.offset) || 0;

    const posts = await listAllPosts(sort, limit, offset);

    // Add user votes if logged in
    if (req.user) {
      const postIds = posts.map((p) => p.id);
      const userVotes = await getUserVotesForPosts(req.user.id, postIds);
      for (const post of posts) {
        post.userVote = userVotes[post.id] || 0;
      }
    }

    res.json(posts);
  } catch (error) {
    logger.error({ err: error }, 'Get posts error');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Create post in subreddit
router.post('/r/:subreddit', requireAuth, async (req, res) => {
  try {
    const { title, content, url } = req.body;

    if (!title) {
      return res.status(400).json({ error: 'Title is required' });
    }

    if (title.length > 300) {
      return res.status(400).json({ error: 'Title must be 300 characters or less' });
    }

    const subreddit = await findSubredditByName(req.params.subreddit);
    if (!subreddit) {
      return res.status(404).json({ error: 'Subreddit not found' });
    }

    const post = await createPost(subreddit.id, req.user.id, title, content || null, url || null);

    res.status(201).json({
      ...post,
      author_username: req.user.username,
      subreddit_name: subreddit.name,
    });
  } catch (error) {
    logger.error({ err: error, userId: req.user?.id }, 'Create post error');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get single post
router.get('/:id', async (req, res) => {
  try {
    const postId = parseInt(req.params.id);
    if (isNaN(postId)) {
      return res.status(400).json({ error: 'Invalid post ID' });
    }

    const post = await findPostById(postId);
    if (!post) {
      return res.status(404).json({ error: 'Post not found' });
    }

    // Add user vote if logged in
    if (req.user) {
      post.userVote = await getUserVote(req.user.id, 'post', postId);
    }

    res.json(post);
  } catch (error) {
    logger.error({ err: error }, 'Get post error');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get post with comments
router.get('/:id/comments', async (req, res) => {
  try {
    const postId = parseInt(req.params.id);
    if (isNaN(postId)) {
      return res.status(400).json({ error: 'Invalid post ID' });
    }

    const post = await findPostById(postId);
    if (!post) {
      return res.status(404).json({ error: 'Post not found' });
    }

    const sort = req.query.sort || 'best';
    const comments = await listCommentsByPost(postId, sort);

    // Add user votes for comments if logged in
    if (req.user) {
      const collectCommentIds = (tree) => {
        const ids = [];
        for (const comment of tree) {
          ids.push(comment.id);
          if (comment.replies?.length) {
            ids.push(...collectCommentIds(comment.replies));
          }
        }
        return ids;
      };

      const commentIds = collectCommentIds(comments);
      const userVotes = await getUserVotesForComments(req.user.id, commentIds);

      const addUserVotes = (tree) => {
        for (const comment of tree) {
          comment.userVote = userVotes[comment.id] || 0;
          if (comment.replies?.length) {
            addUserVotes(comment.replies);
          }
        }
      };

      addUserVotes(comments);
      post.userVote = await getUserVote(req.user.id, 'post', postId);
    }

    res.json({ post, comments });
  } catch (error) {
    logger.error({ err: error }, 'Get post comments error');
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
