import express from 'express';
import { crawler, urlFrontier } from '../services/crawler.js';
import { indexer } from '../services/indexer.js';
import { pageRankCalculator } from '../services/pagerank.js';
import { db } from '../models/db.js';

const router = express.Router();

/**
 * POST /api/admin/crawl/seed
 * Add seed URLs to the crawler frontier
 */
router.post('/crawl/seed', async (req, res) => {
  try {
    const { urls } = req.body;

    if (!urls || !Array.isArray(urls) || urls.length === 0) {
      return res.status(400).json({
        error: 'Array of URLs required',
      });
    }

    const results = [];
    for (const url of urls) {
      const urlId = await urlFrontier.addUrl(url, 1.0); // High priority for seeds
      results.push({ url, urlId, added: urlId !== null });
    }

    res.json({
      message: `Added ${results.filter((r) => r.added).length} seed URLs`,
      results,
    });
  } catch (error) {
    console.error('Seed error:', error);
    res.status(500).json({
      error: 'Failed to add seed URLs',
      message: error.message,
    });
  }
});

/**
 * POST /api/admin/crawl/start
 * Start the crawler
 */
router.post('/crawl/start', async (req, res) => {
  try {
    const { maxPages = 100 } = req.body;

    // Run crawler in background
    res.json({
      message: `Crawler starting with max ${maxPages} pages`,
      status: 'started',
    });

    // Start crawling (this will run asynchronously)
    crawler.run(maxPages).then((result) => {
      console.log('Crawl completed:', result);
    }).catch((error) => {
      console.error('Crawl error:', error);
    });
  } catch (error) {
    console.error('Crawl start error:', error);
    res.status(500).json({
      error: 'Failed to start crawler',
      message: error.message,
    });
  }
});

/**
 * GET /api/admin/crawl/status
 * Get crawl status
 */
router.get('/crawl/status', async (req, res) => {
  try {
    const stats = await indexer.getStats();
    res.json(stats);
  } catch (error) {
    console.error('Status error:', error);
    res.status(500).json({
      error: 'Failed to get status',
      message: error.message,
    });
  }
});

/**
 * POST /api/admin/index/build
 * Build/rebuild the search index
 */
router.post('/index/build', async (req, res) => {
  try {
    res.json({
      message: 'Index build started',
      status: 'started',
    });

    // Run indexing in background
    indexer.indexAll().then((count) => {
      console.log(`Indexing completed: ${count} documents`);
    }).catch((error) => {
      console.error('Indexing error:', error);
    });
  } catch (error) {
    console.error('Index build error:', error);
    res.status(500).json({
      error: 'Failed to start indexing',
      message: error.message,
    });
  }
});

/**
 * POST /api/admin/pagerank/calculate
 * Calculate PageRank for all URLs
 */
router.post('/pagerank/calculate', async (req, res) => {
  try {
    res.json({
      message: 'PageRank calculation started',
      status: 'started',
    });

    // Run PageRank calculation in background
    pageRankCalculator.calculate().then((topPages) => {
      console.log('PageRank calculation completed');
      console.log('Top pages:', topPages);
    }).catch((error) => {
      console.error('PageRank error:', error);
    });
  } catch (error) {
    console.error('PageRank calculation error:', error);
    res.status(500).json({
      error: 'Failed to start PageRank calculation',
      message: error.message,
    });
  }
});

/**
 * GET /api/admin/pagerank/stats
 * Get PageRank statistics
 */
router.get('/pagerank/stats', async (req, res) => {
  try {
    const stats = await pageRankCalculator.getStats();
    res.json(stats);
  } catch (error) {
    console.error('PageRank stats error:', error);
    res.status(500).json({
      error: 'Failed to get PageRank stats',
      message: error.message,
    });
  }
});

/**
 * GET /api/admin/stats
 * Get overall system statistics
 */
router.get('/stats', async (req, res) => {
  try {
    const indexStats = await indexer.getStats();
    const pageRankStats = await pageRankCalculator.getStats();

    // Query logs stats
    const queryStats = await db.query(`
      SELECT
        COUNT(*) as total_queries,
        AVG(duration_ms) as avg_duration,
        COUNT(DISTINCT DATE(created_at)) as days_active
      FROM query_logs
    `);

    res.json({
      index: indexStats,
      pageRank: pageRankStats,
      queries: queryStats.rows[0],
    });
  } catch (error) {
    console.error('Stats error:', error);
    res.status(500).json({
      error: 'Failed to get stats',
      message: error.message,
    });
  }
});

/**
 * POST /api/admin/update-inlinks
 * Update inlink counts for all URLs
 */
router.post('/update-inlinks', async (req, res) => {
  try {
    await indexer.updateInlinkCounts();
    res.json({ message: 'Inlink counts updated' });
  } catch (error) {
    console.error('Update inlinks error:', error);
    res.status(500).json({
      error: 'Failed to update inlink counts',
      message: error.message,
    });
  }
});

export default router;
