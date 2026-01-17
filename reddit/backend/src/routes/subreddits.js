import express from 'express';
import {
  createSubreddit,
  findSubredditByName,
  listSubreddits,
  searchSubreddits,
  subscribe,
  unsubscribe,
  isSubscribed,
} from '../models/subreddit.js';
import { listPostsBySubreddit } from '../models/post.js';
import { getUserVotesForPosts } from '../models/vote.js';
import { requireAuth } from '../middleware/auth.js';

const router = express.Router();

// List all subreddits
router.get('/', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 25, 100);
    const offset = parseInt(req.query.offset) || 0;
    const search = req.query.q;

    let subreddits;
    if (search) {
      subreddits = await searchSubreddits(search, limit);
    } else {
      subreddits = await listSubreddits(limit, offset);
    }

    res.json(subreddits);
  } catch (error) {
    console.error('List subreddits error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Create subreddit
router.post('/', requireAuth, async (req, res) => {
  try {
    const { name, title, description } = req.body;

    if (!name) {
      return res.status(400).json({ error: 'Subreddit name is required' });
    }

    if (!/^[a-zA-Z0-9_]+$/.test(name)) {
      return res.status(400).json({ error: 'Subreddit name can only contain letters, numbers, and underscores' });
    }

    if (name.length < 3 || name.length > 21) {
      return res.status(400).json({ error: 'Subreddit name must be 3-21 characters' });
    }

    const existing = await findSubredditByName(name);
    if (existing) {
      return res.status(409).json({ error: 'Subreddit already exists' });
    }

    const subreddit = await createSubreddit(name, title || name, description || '', req.user.id);

    // Auto-subscribe creator
    await subscribe(req.user.id, subreddit.id);

    res.status(201).json(subreddit);
  } catch (error) {
    console.error('Create subreddit error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get subreddit by name
router.get('/:name', async (req, res) => {
  try {
    const subreddit = await findSubredditByName(req.params.name);
    if (!subreddit) {
      return res.status(404).json({ error: 'Subreddit not found' });
    }

    // Add subscription status if user is logged in
    let subscribed = false;
    if (req.user) {
      subscribed = await isSubscribed(req.user.id, subreddit.id);
    }

    res.json({ ...subreddit, subscribed });
  } catch (error) {
    console.error('Get subreddit error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get posts for subreddit with sorting
router.get('/:name/:sort?', async (req, res) => {
  try {
    const subreddit = await findSubredditByName(req.params.name);
    if (!subreddit) {
      return res.status(404).json({ error: 'Subreddit not found' });
    }

    const sort = req.params.sort || 'hot';
    const limit = Math.min(parseInt(req.query.limit) || 25, 100);
    const offset = parseInt(req.query.offset) || 0;

    const posts = await listPostsBySubreddit(subreddit.id, sort, limit, offset);

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
    console.error('Get subreddit posts error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Subscribe to subreddit
router.post('/:name/subscribe', requireAuth, async (req, res) => {
  try {
    const subreddit = await findSubredditByName(req.params.name);
    if (!subreddit) {
      return res.status(404).json({ error: 'Subreddit not found' });
    }

    const alreadySubscribed = await isSubscribed(req.user.id, subreddit.id);
    if (alreadySubscribed) {
      return res.json({ subscribed: true });
    }

    await subscribe(req.user.id, subreddit.id);
    res.json({ subscribed: true });
  } catch (error) {
    console.error('Subscribe error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Unsubscribe from subreddit
router.post('/:name/unsubscribe', requireAuth, async (req, res) => {
  try {
    const subreddit = await findSubredditByName(req.params.name);
    if (!subreddit) {
      return res.status(404).json({ error: 'Subreddit not found' });
    }

    await unsubscribe(req.user.id, subreddit.id);
    res.json({ subscribed: false });
  } catch (error) {
    console.error('Unsubscribe error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
