import express from 'express';

const router = express.Router();

/**
 * GET /api/v1/admin/trie/stats
 * Get trie statistics.
 */
router.get('/trie/stats', async (req, res) => {
  try {
    const trie = req.app.get('trie');
    const stats = trie.getStats();

    res.json(stats);
  } catch (error) {
    console.error('Trie stats error:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: error.message,
    });
  }
});

/**
 * POST /api/v1/admin/trie/rebuild
 * Rebuild the trie from the database.
 */
router.post('/trie/rebuild', async (req, res) => {
  try {
    const aggregationService = req.app.get('aggregationService');

    await aggregationService.rebuildTrie();

    const trie = req.app.get('trie');
    const stats = trie.getStats();

    res.json({
      success: true,
      message: 'Trie rebuilt successfully',
      stats,
    });
  } catch (error) {
    console.error('Trie rebuild error:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: error.message,
    });
  }
});

/**
 * POST /api/v1/admin/phrases
 * Add or update a phrase in the trie.
 *
 * Body:
 * - phrase: The phrase to add (required)
 * - count: Initial count (default: 1)
 */
router.post('/phrases', async (req, res) => {
  try {
    const { phrase, count = 1 } = req.body;

    if (!phrase || typeof phrase !== 'string') {
      return res.status(400).json({
        error: 'Missing or invalid "phrase" in request body',
      });
    }

    const trie = req.app.get('trie');
    const pgPool = req.app.get('pgPool');
    const suggestionService = req.app.get('suggestionService');

    // Add to trie
    trie.insert(phrase, count);

    // Add to database
    await pgPool.query(`
      INSERT INTO phrase_counts (phrase, count, last_updated)
      VALUES ($1, $2, NOW())
      ON CONFLICT (phrase)
      DO UPDATE SET count = $2, last_updated = NOW()
    `, [phrase.toLowerCase().trim(), count]);

    // Clear cache for this prefix
    await suggestionService.clearCache(phrase.charAt(0));

    res.json({
      success: true,
      message: 'Phrase added successfully',
      phrase: phrase.toLowerCase().trim(),
      count,
    });
  } catch (error) {
    console.error('Add phrase error:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: error.message,
    });
  }
});

/**
 * DELETE /api/v1/admin/phrases/:phrase
 * Remove a phrase from the trie.
 */
router.delete('/phrases/:phrase', async (req, res) => {
  try {
    const { phrase } = req.params;

    const trie = req.app.get('trie');
    const pgPool = req.app.get('pgPool');
    const suggestionService = req.app.get('suggestionService');

    // Remove from trie
    const removed = trie.remove(phrase);

    // Mark as filtered in database
    await pgPool.query(`
      UPDATE phrase_counts
      SET is_filtered = true
      WHERE phrase = $1
    `, [phrase.toLowerCase().trim()]);

    // Clear cache
    await suggestionService.clearCache(phrase.charAt(0));

    res.json({
      success: removed,
      message: removed ? 'Phrase removed successfully' : 'Phrase not found',
    });
  } catch (error) {
    console.error('Remove phrase error:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: error.message,
    });
  }
});

/**
 * POST /api/v1/admin/filter
 * Add a phrase to the filter list.
 *
 * Body:
 * - phrase: The phrase to filter (required)
 * - reason: Reason for filtering (optional)
 */
router.post('/filter', async (req, res) => {
  try {
    const { phrase, reason = 'manual' } = req.body;

    if (!phrase || typeof phrase !== 'string') {
      return res.status(400).json({
        error: 'Missing or invalid "phrase" in request body',
      });
    }

    const pgPool = req.app.get('pgPool');
    const redis = req.app.get('redis');
    const trie = req.app.get('trie');
    const suggestionService = req.app.get('suggestionService');

    // Add to filtered phrases
    await pgPool.query(`
      INSERT INTO filtered_phrases (phrase, reason, added_at)
      VALUES ($1, $2, NOW())
      ON CONFLICT (phrase) DO NOTHING
    `, [phrase.toLowerCase().trim(), reason]);

    // Add to Redis blocked set for fast lookup
    await redis.sadd('blocked_phrases', phrase.toLowerCase().trim());

    // Remove from trie
    trie.remove(phrase);

    // Update phrase_counts
    await pgPool.query(`
      UPDATE phrase_counts
      SET is_filtered = true
      WHERE phrase = $1
    `, [phrase.toLowerCase().trim()]);

    // Clear cache
    await suggestionService.clearCache();

    res.json({
      success: true,
      message: 'Phrase filtered successfully',
      phrase: phrase.toLowerCase().trim(),
    });
  } catch (error) {
    console.error('Filter phrase error:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: error.message,
    });
  }
});

/**
 * GET /api/v1/admin/filtered
 * Get list of filtered phrases.
 *
 * Query params:
 * - limit: Max number of phrases (default: 100)
 */
router.get('/filtered', async (req, res) => {
  try {
    const { limit = 100 } = req.query;
    const pgPool = req.app.get('pgPool');

    const result = await pgPool.query(`
      SELECT phrase, reason, added_at
      FROM filtered_phrases
      ORDER BY added_at DESC
      LIMIT $1
    `, [parseInt(limit)]);

    res.json({
      filtered: result.rows,
      meta: {
        count: result.rows.length,
      },
    });
  } catch (error) {
    console.error('Get filtered error:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: error.message,
    });
  }
});

/**
 * DELETE /api/v1/admin/filter/:phrase
 * Remove a phrase from the filter list.
 */
router.delete('/filter/:phrase', async (req, res) => {
  try {
    const { phrase } = req.params;
    const pgPool = req.app.get('pgPool');
    const redis = req.app.get('redis');

    // Remove from filtered phrases
    await pgPool.query(`
      DELETE FROM filtered_phrases WHERE phrase = $1
    `, [phrase.toLowerCase().trim()]);

    // Remove from Redis blocked set
    await redis.srem('blocked_phrases', phrase.toLowerCase().trim());

    // Unmark in phrase_counts
    await pgPool.query(`
      UPDATE phrase_counts
      SET is_filtered = false
      WHERE phrase = $1
    `, [phrase.toLowerCase().trim()]);

    res.json({
      success: true,
      message: 'Filter removed successfully',
    });
  } catch (error) {
    console.error('Remove filter error:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: error.message,
    });
  }
});

/**
 * POST /api/v1/admin/cache/clear
 * Clear the suggestion cache.
 */
router.post('/cache/clear', async (req, res) => {
  try {
    const suggestionService = req.app.get('suggestionService');
    await suggestionService.clearCache();

    res.json({
      success: true,
      message: 'Cache cleared successfully',
    });
  } catch (error) {
    console.error('Clear cache error:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: error.message,
    });
  }
});

/**
 * GET /api/v1/admin/status
 * Get overall system status.
 */
router.get('/status', async (req, res) => {
  try {
    const redis = req.app.get('redis');
    const pgPool = req.app.get('pgPool');
    const trie = req.app.get('trie');
    const aggregationService = req.app.get('aggregationService');

    // Check Redis
    let redisStatus = 'unknown';
    try {
      const pong = await redis.ping();
      redisStatus = pong === 'PONG' ? 'connected' : 'error';
    } catch (e) {
      redisStatus = 'error';
    }

    // Check PostgreSQL
    let pgStatus = 'unknown';
    try {
      await pgPool.query('SELECT 1');
      pgStatus = 'connected';
    } catch (e) {
      pgStatus = 'error';
    }

    res.json({
      status: redisStatus === 'connected' && pgStatus === 'connected' ? 'healthy' : 'degraded',
      services: {
        redis: redisStatus,
        postgres: pgStatus,
      },
      trie: trie.getStats(),
      aggregation: aggregationService.getStats(),
      uptime: process.uptime(),
      memory: process.memoryUsage(),
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error('Status error:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: error.message,
    });
  }
});

export default router;
