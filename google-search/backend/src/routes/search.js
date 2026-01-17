import express from 'express';
import { queryProcessor } from '../services/search.js';

const router = express.Router();

/**
 * GET /api/search
 * Search for documents
 */
router.get('/', async (req, res) => {
  try {
    const { q, page = 1, limit = 10 } = req.query;

    if (!q || q.trim().length === 0) {
      return res.status(400).json({
        error: 'Query parameter "q" is required',
      });
    }

    const result = await queryProcessor.search(q, {
      page: parseInt(page, 10),
      limit: Math.min(parseInt(limit, 10), 50),
    });

    res.json(result);
  } catch (error) {
    console.error('Search error:', error);
    res.status(500).json({
      error: 'Search failed',
      message: error.message,
    });
  }
});

/**
 * GET /api/search/autocomplete
 * Get autocomplete suggestions
 */
router.get('/autocomplete', async (req, res) => {
  try {
    const { q } = req.query;

    if (!q || q.trim().length < 2) {
      return res.json({ suggestions: [] });
    }

    const suggestions = await queryProcessor.getAutocomplete(q);
    res.json({ suggestions });
  } catch (error) {
    console.error('Autocomplete error:', error);
    res.status(500).json({
      error: 'Autocomplete failed',
      message: error.message,
    });
  }
});

/**
 * GET /api/search/popular
 * Get popular searches
 */
router.get('/popular', async (req, res) => {
  try {
    const { limit = 10 } = req.query;
    const popular = await queryProcessor.getPopularSearches(parseInt(limit, 10));
    res.json({ searches: popular });
  } catch (error) {
    console.error('Popular searches error:', error);
    res.status(500).json({
      error: 'Failed to get popular searches',
      message: error.message,
    });
  }
});

/**
 * GET /api/search/related
 * Get related searches
 */
router.get('/related', async (req, res) => {
  try {
    const { q, limit = 5 } = req.query;

    if (!q) {
      return res.json({ related: [] });
    }

    const related = await queryProcessor.getRelatedSearches(q, parseInt(limit, 10));
    res.json({ related });
  } catch (error) {
    console.error('Related searches error:', error);
    res.status(500).json({
      error: 'Failed to get related searches',
      message: error.message,
    });
  }
});

export default router;
