import express from 'express';
import { queryProcessor } from '../services/search.js';
import { searchRateLimiter, autocompleteRateLimiter } from '../shared/rateLimiter.js';
import {
  queryLatencyHistogram,
  queryCounter,
  queryResultsHistogram,
  recordCacheHit,
  recordCacheMiss,
} from '../shared/metrics.js';
import { logger } from '../shared/logger.js';

const router = express.Router();

/**
 * Helper to bucket result counts for metrics
 */
const getResultBucket = (count) => {
  if (count === 0) return '0';
  if (count <= 10) return '1-10';
  if (count <= 100) return '11-100';
  if (count <= 1000) return '101-1000';
  return '1000+';
};

/**
 * GET /api/search
 * Search for documents
 *
 * Rate limited to prevent resource exhaustion
 * Metrics captured for ranking optimization
 */
router.get('/', searchRateLimiter, async (req, res) => {
  const log = req.log || logger;
  const startTime = Date.now();

  try {
    const { q, page = 1, limit = 10 } = req.query;

    if (!q || q.trim().length === 0) {
      queryCounter.labels('error').inc();
      return res.status(400).json({
        error: 'Query parameter "q" is required',
      });
    }

    log.info({ query: q, page, limit }, 'Search request');

    const result = await queryProcessor.search(q, {
      page: parseInt(page, 10),
      limit: Math.min(parseInt(limit, 10), 50),
    });

    // Record metrics
    const duration = (Date.now() - startTime) / 1000;
    const cacheHit = result.fromCache ? 'true' : 'false';
    const resultBucket = getResultBucket(result.total);

    queryLatencyHistogram.labels(cacheHit, resultBucket).observe(duration);
    queryCounter.labels('success').inc();
    queryResultsHistogram.labels(cacheHit).observe(result.total);

    // Track cache efficiency
    if (result.fromCache) {
      recordCacheHit();
    } else {
      recordCacheMiss();
    }

    log.info(
      {
        query: q,
        totalResults: result.total,
        durationMs: Date.now() - startTime,
        fromCache: result.fromCache,
        page: result.page,
      },
      'Search completed'
    );

    res.json(result);
  } catch (error) {
    queryCounter.labels('error').inc();
    log.error({ error: error.message, query: req.query.q }, 'Search error');

    res.status(500).json({
      error: 'Search failed',
      message: error.message,
    });
  }
});

/**
 * GET /api/search/autocomplete
 * Get autocomplete suggestions
 *
 * Higher rate limit since autocomplete needs to feel responsive
 */
router.get('/autocomplete', autocompleteRateLimiter, async (req, res) => {
  const log = req.log || logger;

  try {
    const { q } = req.query;

    if (!q || q.trim().length < 2) {
      return res.json({ suggestions: [] });
    }

    const suggestions = await queryProcessor.getAutocomplete(q);

    log.debug({ prefix: q, suggestionCount: suggestions.length }, 'Autocomplete request');

    res.json({ suggestions });
  } catch (error) {
    log.error({ error: error.message }, 'Autocomplete error');

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
  const log = req.log || logger;

  try {
    const { limit = 10 } = req.query;
    const popular = await queryProcessor.getPopularSearches(parseInt(limit, 10));

    log.debug({ count: popular.length }, 'Popular searches request');

    res.json({ searches: popular });
  } catch (error) {
    log.error({ error: error.message }, 'Popular searches error');

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
  const log = req.log || logger;

  try {
    const { q, limit = 5 } = req.query;

    if (!q) {
      return res.json({ related: [] });
    }

    const related = await queryProcessor.getRelatedSearches(q, parseInt(limit, 10));

    log.debug({ query: q, count: related.length }, 'Related searches request');

    res.json({ related });
  } catch (error) {
    log.error({ error: error.message }, 'Related searches error');

    res.status(500).json({
      error: 'Failed to get related searches',
      message: error.message,
    });
  }
});

export default router;
