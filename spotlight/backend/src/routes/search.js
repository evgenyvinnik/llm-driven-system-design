import express from 'express';
import { esClient } from '../index.js';
import { parseQuery, formatSpecialResult } from '../services/queryParser.js';
import { searchAll, getSuggestions as getEsSuggestions } from '../services/elasticsearch.js';
import { searchRateLimiter } from '../shared/rateLimiter.js';
import { searchLatency, searchResultCount, searchRequestsTotal } from '../shared/metrics.js';
import { logSearch, searchLogger } from '../shared/logger.js';

const router = express.Router();

// Apply rate limiting to all search routes
router.use(searchRateLimiter);

// ============================================================================
// Main Search Endpoint
// ============================================================================
router.get('/', async (req, res) => {
  const startTime = Date.now();
  const requestId = req.requestId;

  try {
    const { q, types, limit = 20 } = req.query;

    if (!q || q.trim().length === 0) {
      return res.json({ results: [], suggestions: [] });
    }

    const query = q.trim();

    // Parse query to check for special queries
    const parsedQuery = parseQuery(query);

    // Track query type in metrics
    searchRequestsTotal.labels(parsedQuery.type).inc();

    // Handle special queries (math, conversions)
    const specialResult = formatSpecialResult(parsedQuery);
    if (specialResult) {
      const searchStart = Date.now();

      // Also get regular search results
      const searchResults = await searchAll(query, {
        limit: parseInt(limit) - 1,
        types: types ? types.split(',') : undefined
      });

      // Record search latency
      const searchDuration = (Date.now() - searchStart) / 1000;
      searchLatency.labels('all').observe(searchDuration);

      // Record result count
      searchResultCount.observe(searchResults.length + 1);

      // Log search
      logSearch({
        query,
        userId: req.session?.userId,
        resultCount: searchResults.length + 1,
        latencyMs: Date.now() - startTime,
        sources: ['local', 'special'],
        requestId
      });

      return res.json({
        results: [specialResult, ...searchResults],
        query: parsedQuery
      });
    }

    // Regular search with timing
    const searchStart = Date.now();
    const results = await searchAll(query, {
      limit: parseInt(limit),
      types: types ? types.split(',') : undefined
    });
    const searchDuration = (Date.now() - searchStart) / 1000;

    // Record metrics
    searchLatency.labels('all').observe(searchDuration);
    searchResultCount.observe(results.length);

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

    // Log search
    logSearch({
      query,
      userId: req.session?.userId,
      resultCount: results.length,
      latencyMs: Date.now() - startTime,
      sources: ['local'],
      requestId
    });

    res.json({
      results,
      query: parsedQuery
    });
  } catch (error) {
    searchLogger.error({
      error: error.message,
      requestId
    }, 'Search error');
    res.status(500).json({ error: 'Search failed' });
  }
});

// ============================================================================
// Autocomplete/Suggestions Endpoint
// ============================================================================
router.get('/suggest', async (req, res) => {
  const startTime = Date.now();
  const requestId = req.requestId;

  try {
    const { q, limit = 10 } = req.query;

    if (!q || q.trim().length === 0) {
      return res.json({ suggestions: [] });
    }

    const suggestions = await getEsSuggestions(q.trim(), parseInt(limit));

    // Record metrics for suggestions
    searchLatency.labels('suggestions').observe((Date.now() - startTime) / 1000);

    res.json({ suggestions });
  } catch (error) {
    searchLogger.error({
      error: error.message,
      requestId
    }, 'Suggestion error');
    res.status(500).json({ error: 'Suggestions failed' });
  }
});

// ============================================================================
// Search Within Specific Type
// ============================================================================
router.get('/:type', async (req, res) => {
  const startTime = Date.now();
  const requestId = req.requestId;

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

    // Track query by type
    searchRequestsTotal.labels(`type_${type}`).inc();

    const results = await searchAll(q.trim(), {
      limit: parseInt(limit),
      types: [type]
    });

    // Record metrics
    searchLatency.labels(type).observe((Date.now() - startTime) / 1000);
    searchResultCount.observe(results.length);

    // Log search
    logSearch({
      query: q.trim(),
      userId: req.session?.userId,
      resultCount: results.length,
      latencyMs: Date.now() - startTime,
      sources: [type],
      requestId
    });

    res.json({ results });
  } catch (error) {
    searchLogger.error({
      error: error.message,
      requestId
    }, 'Search error');
    res.status(500).json({ error: 'Search failed' });
  }
});

export default router;
