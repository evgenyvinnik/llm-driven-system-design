import express from 'express';
import { esClient } from '../index.js';
import { parseQuery, formatSpecialResult } from '../services/queryParser.js';
import { searchAll, getSuggestions as getEsSuggestions } from '../services/elasticsearch.js';

const router = express.Router();

// Main search endpoint
router.get('/', async (req, res) => {
  try {
    const { q, types, limit = 20 } = req.query;

    if (!q || q.trim().length === 0) {
      return res.json({ results: [], suggestions: [] });
    }

    const query = q.trim();

    // Parse query to check for special queries
    const parsedQuery = parseQuery(query);

    // Handle special queries (math, conversions)
    const specialResult = formatSpecialResult(parsedQuery);
    if (specialResult) {
      // Also get regular search results
      const searchResults = await searchAll(query, {
        limit: parseInt(limit) - 1,
        types: types ? types.split(',') : undefined
      });

      return res.json({
        results: [specialResult, ...searchResults],
        query: parsedQuery
      });
    }

    // Regular search
    const results = await searchAll(query, {
      limit: parseInt(limit),
      types: types ? types.split(',') : undefined
    });

    // Add web search fallback if few results
    if (results.length < 3) {
      results.push({
        type: 'web',
        name: `Search the web for "${query}"`,
        url: `https://www.google.com/search?q=${encodeURIComponent(query)}`,
        icon: 'globe',
        score: 1
      });
    }

    res.json({
      results,
      query: parsedQuery
    });
  } catch (error) {
    console.error('Search error:', error);
    res.status(500).json({ error: 'Search failed' });
  }
});

// Autocomplete/suggestions endpoint
router.get('/suggest', async (req, res) => {
  try {
    const { q, limit = 10 } = req.query;

    if (!q || q.trim().length === 0) {
      return res.json({ suggestions: [] });
    }

    const suggestions = await getEsSuggestions(q.trim(), parseInt(limit));

    res.json({ suggestions });
  } catch (error) {
    console.error('Suggestion error:', error);
    res.status(500).json({ error: 'Suggestions failed' });
  }
});

// Search within specific type
router.get('/:type', async (req, res) => {
  try {
    const { type } = req.params;
    const { q, limit = 20 } = req.query;

    if (!q || q.trim().length === 0) {
      return res.json({ results: [] });
    }

    const validTypes = ['files', 'apps', 'contacts', 'web'];
    if (!validTypes.includes(type)) {
      return res.status(400).json({ error: 'Invalid type' });
    }

    const results = await searchAll(q.trim(), {
      limit: parseInt(limit),
      types: [type]
    });

    res.json({ results });
  } catch (error) {
    console.error('Search error:', error);
    res.status(500).json({ error: 'Search failed' });
  }
});

export default router;
