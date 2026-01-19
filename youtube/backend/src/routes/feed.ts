import express from 'express';
import { authenticate, optionalAuth } from '../middleware/auth.js';
import {
  getRecommendations,
  getTrending,
  searchVideos,
  getSubscriptionFeed,
  getWatchHistory,
} from '../services/recommendations.js';

const router = express.Router();

// Get personalized recommendations (home feed)
router.get('/recommendations', optionalAuth, async (req, res) => {
  try {
    const { limit } = req.query;

    const recommendations = await getRecommendations(
      req.user?.id,
      Math.min(parseInt(limit, 10) || 20, 50)
    );

    res.json({ videos: recommendations });
  } catch (error) {
    console.error('Get recommendations error:', error);
    res.status(500).json({ error: 'Failed to get recommendations' });
  }
});

// Get trending videos
router.get('/trending', optionalAuth, async (req, res) => {
  try {
    const { limit, category } = req.query;

    const trending = await getTrending(
      Math.min(parseInt(limit, 10) || 50, 100),
      category || null
    );

    res.json({ videos: trending });
  } catch (error) {
    console.error('Get trending error:', error);
    res.status(500).json({ error: 'Failed to get trending videos' });
  }
});

// Search videos
router.get('/search', optionalAuth, async (req, res) => {
  try {
    const { q, page, limit, sortBy } = req.query;

    if (!q || q.trim().length === 0) {
      return res.status(400).json({ error: 'Search query is required' });
    }

    const result = await searchVideos(q.trim(), {
      page: parseInt(page, 10) || 1,
      limit: Math.min(parseInt(limit, 10) || 20, 50),
      sortBy,
    });

    res.json(result);
  } catch (error) {
    console.error('Search error:', error);
    res.status(500).json({ error: 'Failed to search videos' });
  }
});

// Get subscription feed
router.get('/subscriptions', authenticate, async (req, res) => {
  try {
    const { page, limit } = req.query;

    const result = await getSubscriptionFeed(
      req.user.id,
      parseInt(page, 10) || 1,
      Math.min(parseInt(limit, 10) || 20, 50)
    );

    res.json(result);
  } catch (error) {
    console.error('Get subscription feed error:', error);
    res.status(500).json({ error: 'Failed to get subscription feed' });
  }
});

// Get watch history
router.get('/history', authenticate, async (req, res) => {
  try {
    const { page, limit } = req.query;

    const result = await getWatchHistory(
      req.user.id,
      parseInt(page, 10) || 1,
      Math.min(parseInt(limit, 10) || 20, 50)
    );

    res.json(result);
  } catch (error) {
    console.error('Get watch history error:', error);
    res.status(500).json({ error: 'Failed to get watch history' });
  }
});

export default router;
