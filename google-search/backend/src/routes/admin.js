import express from 'express';
import { crawler, urlFrontier } from '../services/crawler.js';
import { indexer } from '../services/indexer.js';
import { pageRankCalculator } from '../services/pagerank.js';
import { db } from '../models/db.js';
import { adminRateLimiter } from '../shared/rateLimiter.js';
import {
  indexOperationsCounter,
  indexLatencyHistogram,
  documentsIndexedGauge,
  frontierSizeGauge,
  crawlCounter,
} from '../shared/metrics.js';
import { logger, auditLog } from '../shared/logger.js';
import {
  withIdempotency,
  generateIdempotencyKey,
} from '../shared/idempotency.js';

const router = express.Router();

// Apply admin rate limiter to all admin routes
router.use(adminRateLimiter);

/**
 * POST /api/admin/crawl/seed
 * Add seed URLs to the crawler frontier
 */
router.post('/crawl/seed', async (req, res) => {
  const log = req.log || logger;

  try {
    const { urls } = req.body;

    if (!urls || !Array.isArray(urls) || urls.length === 0) {
      return res.status(400).json({
        error: 'Array of URLs required',
      });
    }

    log.info({ urlCount: urls.length }, 'Adding seed URLs');

    const results = [];
    for (const url of urls) {
      const urlId = await urlFrontier.addUrl(url, 1.0); // High priority for seeds
      results.push({ url, urlId, added: urlId !== null });
    }

    // Audit log
    auditLog('crawl_seed', {
      actor: req.ip,
      resource: 'crawler',
      resourceId: 'frontier',
      outcome: 'success',
      metadata: { urlCount: urls.length, added: results.filter((r) => r.added).length },
      ipAddress: req.ip,
    });

    // Update frontier size metric
    const frontierCount = await db.query(
      "SELECT COUNT(*) FROM urls WHERE crawl_status = 'pending'"
    );
    frontierSizeGauge.set(parseInt(frontierCount.rows[0].count, 10));

    res.json({
      message: `Added ${results.filter((r) => r.added).length} seed URLs`,
      results,
    });
  } catch (error) {
    log.error({ error: error.message }, 'Seed error');
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
  const log = req.log || logger;

  try {
    const { maxPages = 100 } = req.body;

    // Generate idempotency key for this crawl session
    const idempotencyKey = generateIdempotencyKey('crawl', {
      timestamp: Math.floor(Date.now() / 60000), // Group by minute
      maxPages,
    });

    log.info({ maxPages, idempotencyKey }, 'Starting crawler');

    auditLog('crawl_start', {
      actor: req.ip,
      resource: 'crawler',
      outcome: 'success',
      metadata: { maxPages },
      ipAddress: req.ip,
    });

    res.json({
      message: `Crawler starting with max ${maxPages} pages`,
      status: 'started',
      idempotencyKey,
    });

    // Start crawling (this will run asynchronously)
    crawler
      .run(maxPages)
      .then((result) => {
        log.info({ result }, 'Crawl completed');
        crawlCounter.labels('200', 'text/html').inc(result?.crawled || 0);
      })
      .catch((error) => {
        log.error({ error: error.message }, 'Crawl error');
      });
  } catch (error) {
    log.error({ error: error.message }, 'Crawl start error');
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
  const log = req.log || logger;

  try {
    const stats = await indexer.getStats();

    // Update metrics
    frontierSizeGauge.set(parseInt(stats.urls.pending, 10));
    documentsIndexedGauge.set(parseInt(stats.documents.total, 10));

    res.json(stats);
  } catch (error) {
    log.error({ error: error.message }, 'Status error');
    res.status(500).json({
      error: 'Failed to get status',
      message: error.message,
    });
  }
});

/**
 * POST /api/admin/index/build
 * Build/rebuild the search index
 *
 * Uses idempotency to prevent duplicate index builds
 */
router.post('/index/build', async (req, res) => {
  const log = req.log || logger;

  try {
    // Generate idempotency key - prevent multiple builds in same minute
    const idempotencyKey = generateIdempotencyKey('index_build', {
      timestamp: Math.floor(Date.now() / 60000),
    });

    log.info({ idempotencyKey }, 'Starting index build');

    auditLog('index_build', {
      actor: req.ip,
      resource: 'elasticsearch',
      resourceId: 'documents',
      outcome: 'started',
      ipAddress: req.ip,
    });

    indexOperationsCounter.labels('build', 'started').inc();

    res.json({
      message: 'Index build started',
      status: 'started',
      idempotencyKey,
    });

    // Run indexing with idempotency
    const startTime = Date.now();
    withIdempotency(
      idempotencyKey,
      async () => {
        const count = await indexer.indexAll();
        return { count, duration: Date.now() - startTime };
      },
      { ttl: 300 } // 5 minute TTL for index builds
    )
      .then((result) => {
        log.info(
          { count: result.count, durationMs: result.duration, idempotent: result.idempotent },
          'Indexing completed'
        );
        indexOperationsCounter.labels('build', 'success').inc();
        indexLatencyHistogram.labels('build').observe(result.duration / 1000);
        documentsIndexedGauge.set(result.count);

        auditLog('index_build', {
          actor: 'system',
          resource: 'elasticsearch',
          resourceId: 'documents',
          outcome: 'success',
          metadata: { documentCount: result.count, durationMs: result.duration },
        });
      })
      .catch((error) => {
        log.error({ error: error.message }, 'Indexing error');
        indexOperationsCounter.labels('build', 'error').inc();

        auditLog('index_build', {
          actor: 'system',
          resource: 'elasticsearch',
          resourceId: 'documents',
          outcome: 'failure',
          metadata: { error: error.message },
        });
      });
  } catch (error) {
    log.error({ error: error.message }, 'Index build error');
    indexOperationsCounter.labels('build', 'error').inc();
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
  const log = req.log || logger;

  try {
    // Idempotency key - prevent multiple calculations in same 5 minutes
    const idempotencyKey = generateIdempotencyKey('pagerank', {
      timestamp: Math.floor(Date.now() / 300000),
    });

    log.info({ idempotencyKey }, 'Starting PageRank calculation');

    auditLog('pagerank_calculate', {
      actor: req.ip,
      resource: 'pagerank',
      outcome: 'started',
      ipAddress: req.ip,
    });

    res.json({
      message: 'PageRank calculation started',
      status: 'started',
      idempotencyKey,
    });

    // Run PageRank calculation with idempotency
    const startTime = Date.now();
    withIdempotency(
      idempotencyKey,
      async () => {
        const topPages = await pageRankCalculator.calculate();
        return { topPages, duration: Date.now() - startTime };
      },
      { ttl: 600 } // 10 minute TTL
    )
      .then((result) => {
        log.info(
          { topPagesCount: result.topPages?.length, durationMs: result.duration },
          'PageRank calculation completed'
        );

        auditLog('pagerank_calculate', {
          actor: 'system',
          resource: 'pagerank',
          outcome: 'success',
          metadata: { durationMs: result.duration },
        });
      })
      .catch((error) => {
        log.error({ error: error.message }, 'PageRank error');

        auditLog('pagerank_calculate', {
          actor: 'system',
          resource: 'pagerank',
          outcome: 'failure',
          metadata: { error: error.message },
        });
      });
  } catch (error) {
    log.error({ error: error.message }, 'PageRank calculation error');
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
  const log = req.log || logger;

  try {
    const stats = await pageRankCalculator.getStats();
    res.json(stats);
  } catch (error) {
    log.error({ error: error.message }, 'PageRank stats error');
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
  const log = req.log || logger;

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

    // Update metrics
    frontierSizeGauge.set(parseInt(indexStats.urls.pending, 10));
    documentsIndexedGauge.set(parseInt(indexStats.documents.total, 10));

    res.json({
      index: indexStats,
      pageRank: pageRankStats,
      queries: queryStats.rows[0],
    });
  } catch (error) {
    log.error({ error: error.message }, 'Stats error');
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
  const log = req.log || logger;

  try {
    const idempotencyKey = generateIdempotencyKey('update_inlinks', {
      timestamp: Math.floor(Date.now() / 60000),
    });

    log.info({ idempotencyKey }, 'Updating inlink counts');

    await withIdempotency(
      idempotencyKey,
      async () => {
        await indexer.updateInlinkCounts();
        return { updated: true };
      },
      { ttl: 300 }
    );

    auditLog('update_inlinks', {
      actor: req.ip,
      resource: 'urls',
      outcome: 'success',
      ipAddress: req.ip,
    });

    res.json({ message: 'Inlink counts updated' });
  } catch (error) {
    log.error({ error: error.message }, 'Update inlinks error');
    res.status(500).json({
      error: 'Failed to update inlink counts',
      message: error.message,
    });
  }
});

export default router;
