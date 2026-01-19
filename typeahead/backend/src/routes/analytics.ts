import express from 'express';

const router = express.Router();

/**
 * GET /api/v1/analytics/summary
 * Get analytics summary for the typeahead service.
 */
router.get('/summary', async (req, res) => {
  try {
    const pgPool = req.app.get('pgPool');
    const trie = req.app.get('trie');
    const aggregationService = req.app.get('aggregationService');

    // Get today's query stats
    const todayStats = await pgPool.query(`
      SELECT
        COUNT(*) as total_queries,
        COUNT(DISTINCT query) as unique_queries,
        COUNT(DISTINCT user_id) as unique_users,
        AVG(LENGTH(query)) as avg_query_length
      FROM query_logs
      WHERE timestamp >= CURRENT_DATE
    `);

    // Get all-time stats
    const allTimeStats = await pgPool.query(`
      SELECT
        COUNT(*) as total_queries,
        COUNT(DISTINCT query) as unique_queries
      FROM query_logs
    `);

    // Get phrase count stats
    const phraseStats = await pgPool.query(`
      SELECT
        COUNT(*) as total_phrases,
        SUM(count) as total_searches,
        MAX(count) as max_phrase_count
      FROM phrase_counts
      WHERE is_filtered = false
    `);

    // Get trie stats
    const trieStats = trie.getStats();

    // Get aggregation stats
    const aggStats = aggregationService.getStats();

    res.json({
      today: {
        totalQueries: parseInt(todayStats.rows[0]?.total_queries || 0),
        uniqueQueries: parseInt(todayStats.rows[0]?.unique_queries || 0),
        uniqueUsers: parseInt(todayStats.rows[0]?.unique_users || 0),
        avgQueryLength: parseFloat(todayStats.rows[0]?.avg_query_length || 0).toFixed(2),
      },
      allTime: {
        totalQueries: parseInt(allTimeStats.rows[0]?.total_queries || 0),
        uniqueQueries: parseInt(allTimeStats.rows[0]?.unique_queries || 0),
      },
      phrases: {
        totalPhrases: parseInt(phraseStats.rows[0]?.total_phrases || 0),
        totalSearches: parseInt(phraseStats.rows[0]?.total_searches || 0),
        maxPhraseCount: parseInt(phraseStats.rows[0]?.max_phrase_count || 0),
      },
      trie: trieStats,
      aggregation: aggStats,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error('Analytics summary error:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: error.message,
    });
  }
});

/**
 * GET /api/v1/analytics/queries
 * Get recent queries with optional filtering.
 *
 * Query params:
 * - limit: Max number of queries (default: 50)
 * - offset: Pagination offset (default: 0)
 * - search: Filter by query text (optional)
 */
router.get('/queries', async (req, res) => {
  try {
    const { limit = 50, offset = 0, search } = req.query;
    const pgPool = req.app.get('pgPool');

    let query;
    let params;

    if (search) {
      query = `
        SELECT query, COUNT(*) as count, MAX(timestamp) as last_seen
        FROM query_logs
        WHERE query ILIKE $1
        GROUP BY query
        ORDER BY count DESC
        LIMIT $2 OFFSET $3
      `;
      params = [`%${search}%`, parseInt(limit), parseInt(offset)];
    } else {
      query = `
        SELECT query, COUNT(*) as count, MAX(timestamp) as last_seen
        FROM query_logs
        WHERE timestamp >= NOW() - INTERVAL '24 hours'
        GROUP BY query
        ORDER BY count DESC
        LIMIT $1 OFFSET $2
      `;
      params = [parseInt(limit), parseInt(offset)];
    }

    const result = await pgPool.query(query, params);

    res.json({
      queries: result.rows.map(row => ({
        query: row.query,
        count: parseInt(row.count),
        lastSeen: row.last_seen,
      })),
      meta: {
        count: result.rows.length,
        limit: parseInt(limit),
        offset: parseInt(offset),
      },
    });
  } catch (error) {
    console.error('Analytics queries error:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: error.message,
    });
  }
});

/**
 * GET /api/v1/analytics/top-phrases
 * Get top phrases by count.
 *
 * Query params:
 * - limit: Max number of phrases (default: 50)
 */
router.get('/top-phrases', async (req, res) => {
  try {
    const { limit = 50 } = req.query;
    const pgPool = req.app.get('pgPool');

    const result = await pgPool.query(`
      SELECT phrase, count, last_updated
      FROM phrase_counts
      WHERE is_filtered = false
      ORDER BY count DESC
      LIMIT $1
    `, [parseInt(limit)]);

    res.json({
      phrases: result.rows.map(row => ({
        phrase: row.phrase,
        count: parseInt(row.count),
        lastUpdated: row.last_updated,
      })),
      meta: {
        count: result.rows.length,
      },
    });
  } catch (error) {
    console.error('Analytics top-phrases error:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: error.message,
    });
  }
});

/**
 * GET /api/v1/analytics/hourly
 * Get query volume by hour for the last 24 hours.
 */
router.get('/hourly', async (req, res) => {
  try {
    const pgPool = req.app.get('pgPool');

    const result = await pgPool.query(`
      SELECT
        DATE_TRUNC('hour', timestamp) as hour,
        COUNT(*) as query_count,
        COUNT(DISTINCT query) as unique_queries,
        COUNT(DISTINCT user_id) as unique_users
      FROM query_logs
      WHERE timestamp >= NOW() - INTERVAL '24 hours'
      GROUP BY DATE_TRUNC('hour', timestamp)
      ORDER BY hour DESC
    `);

    res.json({
      hourly: result.rows.map(row => ({
        hour: row.hour,
        queryCount: parseInt(row.query_count),
        uniqueQueries: parseInt(row.unique_queries),
        uniqueUsers: parseInt(row.unique_users),
      })),
    });
  } catch (error) {
    console.error('Analytics hourly error:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: error.message,
    });
  }
});

export default router;
