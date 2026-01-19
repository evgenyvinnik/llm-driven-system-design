import express from 'express';
import { adminRateLimiter } from '../shared/rate-limiter.js';
import { idempotencyMiddleware, generateIdempotencyKey } from '../shared/idempotency.js';
import logger, { auditLogger } from '../shared/logger.js';
import { suggestionRequests, suggestionLatency } from '../shared/metrics.js';

const router = express.Router();

// Apply admin rate limiting to all admin routes
router.use(adminRateLimiter);

/**
 * GET /api/v1/admin/trie/stats
 * Get trie statistics.
 */
router.get('/trie/stats', async (req, res) => {
  const timer = suggestionLatency.startTimer();

  try {
    const trie = req.app.get('trie');
    const stats = trie.getStats();

    timer({ endpoint: 'admin_trie_stats', cache_hit: 'false', status: 'success' });
    suggestionRequests.inc({ endpoint: 'admin_trie_stats', status: 'success' });

    res.json(stats);
  } catch (error) {
    timer({ endpoint: 'admin_trie_stats', cache_hit: 'false', status: 'error' });
    suggestionRequests.inc({ endpoint: 'admin_trie_stats', status: 'error' });

    logger.error({
      event: 'trie_stats_error',
      error: error.message,
    });

    res.status(500).json({
      error: 'Internal server error',
      message: error.message,
    });
  }
});

/**
 * POST /api/v1/admin/trie/rebuild
 * Rebuild the trie from the database.
 *
 * WHY idempotency: Prevents duplicate rebuilds on retry
 */
router.post('/trie/rebuild', idempotencyMiddleware('trie_rebuild'), async (req, res) => {
  const timer = suggestionLatency.startTimer();
  const startTime = Date.now();

  try {
    const aggregationService = req.app.get('aggregationService');

    logger.info({
      event: 'trie_rebuild_started',
      idempotencyKey: req.idempotencyKey,
    });

    await aggregationService.rebuildTrie();

    const trie = req.app.get('trie');
    const stats = trie.getStats();
    const durationMs = Date.now() - startTime;

    auditLogger.logTrieRebuild('manual', stats.phraseCount, durationMs);

    timer({ endpoint: 'admin_trie_rebuild', cache_hit: 'false', status: 'success' });
    suggestionRequests.inc({ endpoint: 'admin_trie_rebuild', status: 'success' });

    res.json({
      success: true,
      message: 'Trie rebuilt successfully',
      stats,
      durationMs,
      idempotencyKey: req.idempotencyKey,
    });
  } catch (error) {
    timer({ endpoint: 'admin_trie_rebuild', cache_hit: 'false', status: 'error' });
    suggestionRequests.inc({ endpoint: 'admin_trie_rebuild', status: 'error' });

    logger.error({
      event: 'trie_rebuild_error',
      error: error.message,
      stack: error.stack,
    });

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
 * WHY idempotency: Prevents duplicate phrase inserts on retry
 *
 * Body:
 * - phrase: The phrase to add (required)
 * - count: Initial count (default: 1)
 */
router.post('/phrases', idempotencyMiddleware('phrase_add'), async (req, res) => {
  const timer = suggestionLatency.startTimer();

  try {
    const { phrase, count = 1 } = req.body;

    if (!phrase || typeof phrase !== 'string') {
      timer({ endpoint: 'admin_phrase_add', cache_hit: 'false', status: 'error' });
      suggestionRequests.inc({ endpoint: 'admin_phrase_add', status: 'validation_error' });
      return res.status(400).json({
        error: 'Missing or invalid "phrase" in request body',
      });
    }

    const trie = req.app.get('trie');
    const pgPool = req.app.get('pgPool');
    const suggestionService = req.app.get('suggestionService');

    const normalizedPhrase = phrase.toLowerCase().trim();

    // Add to trie
    trie.insert(normalizedPhrase, count);

    // Add to database with idempotent upsert
    await pgPool.query(
      `
      INSERT INTO phrase_counts (phrase, count, last_updated)
      VALUES ($1, $2, NOW())
      ON CONFLICT (phrase)
      DO UPDATE SET count = $2, last_updated = NOW()
    `,
      [normalizedPhrase, count]
    );

    // Clear cache for this prefix
    await suggestionService.clearCache(normalizedPhrase.charAt(0));
    auditLogger.logCacheInvalidation(normalizedPhrase.charAt(0), 'phrase_added');

    logger.info({
      event: 'phrase_added',
      phrase: normalizedPhrase.substring(0, 50),
      count,
      idempotencyKey: req.idempotencyKey,
    });

    timer({ endpoint: 'admin_phrase_add', cache_hit: 'false', status: 'success' });
    suggestionRequests.inc({ endpoint: 'admin_phrase_add', status: 'success' });

    res.json({
      success: true,
      message: 'Phrase added successfully',
      phrase: normalizedPhrase,
      count,
      idempotencyKey: req.idempotencyKey,
    });
  } catch (error) {
    timer({ endpoint: 'admin_phrase_add', cache_hit: 'false', status: 'error' });
    suggestionRequests.inc({ endpoint: 'admin_phrase_add', status: 'error' });

    logger.error({
      event: 'add_phrase_error',
      error: error.message,
    });

    res.status(500).json({
      error: 'Internal server error',
      message: error.message,
    });
  }
});

/**
 * DELETE /api/v1/admin/phrases/:phrase
 * Remove a phrase from the trie.
 *
 * WHY idempotency: Ensures phrase is only removed once
 */
router.delete('/phrases/:phrase', async (req, res) => {
  const timer = suggestionLatency.startTimer();

  try {
    const { phrase } = req.params;
    const normalizedPhrase = phrase.toLowerCase().trim();

    // Generate idempotency key for DELETE
    const idempotencyKey = generateIdempotencyKey('phrase_delete', { phrase: normalizedPhrase });

    const trie = req.app.get('trie');
    const pgPool = req.app.get('pgPool');
    const suggestionService = req.app.get('suggestionService');
    const idempotencyHandler = req.app.get('idempotencyHandler');

    // Check idempotency
    const cached = await idempotencyHandler.check(idempotencyKey);
    if (cached) {
      logger.info({
        event: 'phrase_delete_idempotent',
        phrase: normalizedPhrase.substring(0, 50),
        idempotencyKey,
      });

      timer({ endpoint: 'admin_phrase_delete', cache_hit: 'true', status: 'success' });
      suggestionRequests.inc({ endpoint: 'admin_phrase_delete', status: 'idempotent' });

      return res.json(cached.result);
    }

    // Remove from trie
    const removed = trie.remove(normalizedPhrase);

    // Mark as filtered in database
    await pgPool.query(
      `
      UPDATE phrase_counts
      SET is_filtered = true
      WHERE phrase = $1
    `,
      [normalizedPhrase]
    );

    // Clear cache
    await suggestionService.clearCache(normalizedPhrase.charAt(0));
    auditLogger.logCacheInvalidation(normalizedPhrase.charAt(0), 'phrase_removed');

    const result = {
      success: removed,
      message: removed ? 'Phrase removed successfully' : 'Phrase not found',
      idempotencyKey,
    };

    // Store result for idempotency
    await idempotencyHandler.store(idempotencyKey, 'phrase_delete', result);

    logger.info({
      event: 'phrase_removed',
      phrase: normalizedPhrase.substring(0, 50),
      removed,
      idempotencyKey,
    });

    timer({ endpoint: 'admin_phrase_delete', cache_hit: 'false', status: 'success' });
    suggestionRequests.inc({ endpoint: 'admin_phrase_delete', status: 'success' });

    res.json(result);
  } catch (error) {
    timer({ endpoint: 'admin_phrase_delete', cache_hit: 'false', status: 'error' });
    suggestionRequests.inc({ endpoint: 'admin_phrase_delete', status: 'error' });

    logger.error({
      event: 'remove_phrase_error',
      error: error.message,
    });

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
 * WHY idempotency: Prevents duplicate filter additions
 *
 * Body:
 * - phrase: The phrase to filter (required)
 * - reason: Reason for filtering (optional)
 */
router.post('/filter', idempotencyMiddleware('filter_add'), async (req, res) => {
  const timer = suggestionLatency.startTimer();

  try {
    const { phrase, reason = 'manual' } = req.body;

    if (!phrase || typeof phrase !== 'string') {
      timer({ endpoint: 'admin_filter_add', cache_hit: 'false', status: 'error' });
      suggestionRequests.inc({ endpoint: 'admin_filter_add', status: 'validation_error' });
      return res.status(400).json({
        error: 'Missing or invalid "phrase" in request body',
      });
    }

    const normalizedPhrase = phrase.toLowerCase().trim();
    const pgPool = req.app.get('pgPool');
    const redis = req.app.get('redis');
    const trie = req.app.get('trie');
    const suggestionService = req.app.get('suggestionService');

    // Add to filtered phrases
    await pgPool.query(
      `
      INSERT INTO filtered_phrases (phrase, reason, added_at)
      VALUES ($1, $2, NOW())
      ON CONFLICT (phrase) DO NOTHING
    `,
      [normalizedPhrase, reason]
    );

    // Add to Redis blocked set for fast lookup
    await redis.sadd('blocked_phrases', normalizedPhrase);

    // Remove from trie
    trie.remove(normalizedPhrase);

    // Update phrase_counts
    await pgPool.query(
      `
      UPDATE phrase_counts
      SET is_filtered = true
      WHERE phrase = $1
    `,
      [normalizedPhrase]
    );

    // Clear cache
    await suggestionService.clearCache();

    auditLogger.logFilterChange('add', normalizedPhrase, reason);
    auditLogger.logCacheInvalidation('*', 'filter_added');

    logger.info({
      event: 'phrase_filtered',
      phrase: normalizedPhrase.substring(0, 50),
      reason,
      idempotencyKey: req.idempotencyKey,
    });

    timer({ endpoint: 'admin_filter_add', cache_hit: 'false', status: 'success' });
    suggestionRequests.inc({ endpoint: 'admin_filter_add', status: 'success' });

    res.json({
      success: true,
      message: 'Phrase filtered successfully',
      phrase: normalizedPhrase,
      idempotencyKey: req.idempotencyKey,
    });
  } catch (error) {
    timer({ endpoint: 'admin_filter_add', cache_hit: 'false', status: 'error' });
    suggestionRequests.inc({ endpoint: 'admin_filter_add', status: 'error' });

    logger.error({
      event: 'filter_phrase_error',
      error: error.message,
    });

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
  const timer = suggestionLatency.startTimer();

  try {
    const { limit = 100 } = req.query;
    const pgPool = req.app.get('pgPool');

    const result = await pgPool.query(
      `
      SELECT phrase, reason, added_at
      FROM filtered_phrases
      ORDER BY added_at DESC
      LIMIT $1
    `,
      [parseInt(limit)]
    );

    timer({ endpoint: 'admin_filtered_list', cache_hit: 'false', status: 'success' });
    suggestionRequests.inc({ endpoint: 'admin_filtered_list', status: 'success' });

    res.json({
      filtered: result.rows,
      meta: {
        count: result.rows.length,
      },
    });
  } catch (error) {
    timer({ endpoint: 'admin_filtered_list', cache_hit: 'false', status: 'error' });
    suggestionRequests.inc({ endpoint: 'admin_filtered_list', status: 'error' });

    logger.error({
      event: 'get_filtered_error',
      error: error.message,
    });

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
  const timer = suggestionLatency.startTimer();

  try {
    const { phrase } = req.params;
    const normalizedPhrase = phrase.toLowerCase().trim();
    const pgPool = req.app.get('pgPool');
    const redis = req.app.get('redis');

    // Remove from filtered phrases
    await pgPool.query(
      `
      DELETE FROM filtered_phrases WHERE phrase = $1
    `,
      [normalizedPhrase]
    );

    // Remove from Redis blocked set
    await redis.srem('blocked_phrases', normalizedPhrase);

    // Unmark in phrase_counts
    await pgPool.query(
      `
      UPDATE phrase_counts
      SET is_filtered = false
      WHERE phrase = $1
    `,
      [normalizedPhrase]
    );

    auditLogger.logFilterChange('remove', normalizedPhrase, 'manual_removal');

    logger.info({
      event: 'filter_removed',
      phrase: normalizedPhrase.substring(0, 50),
    });

    timer({ endpoint: 'admin_filter_remove', cache_hit: 'false', status: 'success' });
    suggestionRequests.inc({ endpoint: 'admin_filter_remove', status: 'success' });

    res.json({
      success: true,
      message: 'Filter removed successfully',
    });
  } catch (error) {
    timer({ endpoint: 'admin_filter_remove', cache_hit: 'false', status: 'error' });
    suggestionRequests.inc({ endpoint: 'admin_filter_remove', status: 'error' });

    logger.error({
      event: 'remove_filter_error',
      error: error.message,
    });

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
router.post('/cache/clear', idempotencyMiddleware('cache_clear'), async (req, res) => {
  const timer = suggestionLatency.startTimer();

  try {
    const suggestionService = req.app.get('suggestionService');
    await suggestionService.clearCache();

    auditLogger.logCacheInvalidation('*', 'manual_clear');

    logger.info({
      event: 'cache_cleared',
      idempotencyKey: req.idempotencyKey,
    });

    timer({ endpoint: 'admin_cache_clear', cache_hit: 'false', status: 'success' });
    suggestionRequests.inc({ endpoint: 'admin_cache_clear', status: 'success' });

    res.json({
      success: true,
      message: 'Cache cleared successfully',
      idempotencyKey: req.idempotencyKey,
    });
  } catch (error) {
    timer({ endpoint: 'admin_cache_clear', cache_hit: 'false', status: 'error' });
    suggestionRequests.inc({ endpoint: 'admin_cache_clear', status: 'error' });

    logger.error({
      event: 'clear_cache_error',
      error: error.message,
    });

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
  const timer = suggestionLatency.startTimer();

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

    timer({ endpoint: 'admin_status', cache_hit: 'false', status: 'success' });
    suggestionRequests.inc({ endpoint: 'admin_status', status: 'success' });

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
    timer({ endpoint: 'admin_status', cache_hit: 'false', status: 'error' });
    suggestionRequests.inc({ endpoint: 'admin_status', status: 'error' });

    logger.error({
      event: 'status_error',
      error: error.message,
    });

    res.status(500).json({
      error: 'Internal server error',
      message: error.message,
    });
  }
});

export default router;
