import express from 'express';

const router = express.Router();

/**
 * GET /api/v1/suggestions
 * Get autocomplete suggestions for a prefix.
 *
 * Query params:
 * - q: The search prefix (required)
 * - limit: Max number of suggestions (default: 5)
 * - userId: User ID for personalization (optional)
 * - fuzzy: Enable fuzzy matching (default: false)
 */
router.get('/', async (req, res) => {
  const startTime = Date.now();

  try {
    const { q: prefix, limit = 5, userId, fuzzy = 'false' } = req.query;

    if (!prefix || typeof prefix !== 'string') {
      return res.status(400).json({
        error: 'Missing or invalid query parameter "q"',
      });
    }

    const suggestionService = req.app.get('suggestionService');

    let suggestions;
    if (fuzzy === 'true') {
      suggestions = await suggestionService.getFuzzySuggestions(prefix, {
        userId,
        limit: parseInt(limit),
      });
    } else {
      suggestions = await suggestionService.getSuggestions(prefix, {
        userId,
        limit: parseInt(limit),
      });
    }

    const responseTime = Date.now() - startTime;

    res.json({
      prefix,
      suggestions,
      meta: {
        count: suggestions.length,
        responseTimeMs: responseTime,
        cached: false, // We don't track this currently
      },
    });
  } catch (error) {
    console.error('Suggestion error:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: error.message,
    });
  }
});

/**
 * POST /api/v1/suggestions/log
 * Log a completed search (user selected a suggestion or pressed enter).
 * This updates popularity counts and personalization data.
 *
 * Body:
 * - query: The completed search query (required)
 * - userId: User ID (optional)
 * - sessionId: Session ID (optional)
 */
router.post('/log', async (req, res) => {
  try {
    const { query, userId, sessionId } = req.body;

    if (!query || typeof query !== 'string') {
      return res.status(400).json({
        error: 'Missing or invalid "query" in request body',
      });
    }

    const aggregationService = req.app.get('aggregationService');
    const rankingService = req.app.get('rankingService');

    // Process the query (updates counts, trending, logs)
    await aggregationService.processQuery(query, userId, sessionId);

    // Update user history if userId provided
    if (userId) {
      await rankingService.recordUserSearch(userId, query);
    }

    res.json({
      success: true,
      message: 'Query logged successfully',
    });
  } catch (error) {
    console.error('Log error:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: error.message,
    });
  }
});

/**
 * GET /api/v1/suggestions/trending
 * Get currently trending queries.
 *
 * Query params:
 * - limit: Max number of trending queries (default: 10)
 */
router.get('/trending', async (req, res) => {
  try {
    const { limit = 10 } = req.query;

    const rankingService = req.app.get('rankingService');
    const trending = await rankingService.getTopTrending(parseInt(limit));

    res.json({
      trending,
      meta: {
        count: trending.length,
        timestamp: new Date().toISOString(),
      },
    });
  } catch (error) {
    console.error('Trending error:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: error.message,
    });
  }
});

/**
 * GET /api/v1/suggestions/popular
 * Get most popular queries overall.
 *
 * Query params:
 * - limit: Max number of queries (default: 10)
 */
router.get('/popular', async (req, res) => {
  try {
    const { limit = 10 } = req.query;

    const suggestionService = req.app.get('suggestionService');
    const popular = await suggestionService.getSuggestions('', {
      limit: parseInt(limit),
    });

    res.json({
      popular,
      meta: {
        count: popular.length,
      },
    });
  } catch (error) {
    console.error('Popular error:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: error.message,
    });
  }
});

/**
 * GET /api/v1/suggestions/history
 * Get user's search history.
 *
 * Query params:
 * - userId: User ID (required)
 * - limit: Max number of history items (default: 10)
 */
router.get('/history', async (req, res) => {
  try {
    const { userId, limit = 10 } = req.query;

    if (!userId) {
      return res.status(400).json({
        error: 'Missing userId parameter',
      });
    }

    const rankingService = req.app.get('rankingService');
    const history = await rankingService.getUserHistory(userId, parseInt(limit));

    res.json({
      history,
      meta: {
        count: history.length,
        userId,
      },
    });
  } catch (error) {
    console.error('History error:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: error.message,
    });
  }
});

export default router;
