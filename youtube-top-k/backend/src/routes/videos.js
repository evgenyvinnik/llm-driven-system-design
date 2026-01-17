import express from 'express';
import { v4 as uuidv4 } from 'uuid';
import { query } from '../models/database.js';
import { TrendingService } from '../services/trendingService.js';
import { processViewWithIdempotency, getIdempotencyStats } from '../services/idempotency.js';
import logger, { logError } from '../shared/logger.js';
import { viewEventsTotal } from '../shared/metrics.js';

const router = express.Router();

/**
 * GET /api/videos
 * List all videos with pagination
 */
router.get('/', async (req, res) => {
  try {
    const { page = 1, limit = 20, category } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);

    let sql = `
      SELECT id, title, description, thumbnail_url, channel_name, category,
             duration_seconds, total_views, created_at
      FROM videos
    `;
    const params = [];

    if (category && category !== 'all') {
      sql += ' WHERE category = $1';
      params.push(category);
    }

    sql += ' ORDER BY created_at DESC';
    sql += ` LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    params.push(parseInt(limit), offset);

    const result = await query(sql, params);

    // Get total count
    let countSql = 'SELECT COUNT(*) FROM videos';
    const countParams = [];
    if (category && category !== 'all') {
      countSql += ' WHERE category = $1';
      countParams.push(category);
    }
    const countResult = await query(countSql, countParams);

    res.json({
      videos: result.rows,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total: parseInt(countResult.rows[0].count),
        totalPages: Math.ceil(parseInt(countResult.rows[0].count) / parseInt(limit)),
      },
    });
  } catch (error) {
    logError(error, { endpoint: 'GET /api/videos' });
    res.status(500).json({ error: 'Failed to list videos' });
  }
});

/**
 * GET /api/videos/:id
 * Get a single video by ID
 */
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const result = await query(
      `SELECT id, title, description, thumbnail_url, channel_name, category,
              duration_seconds, total_views, created_at
       FROM videos WHERE id = $1`,
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Video not found' });
    }

    res.json(result.rows[0]);
  } catch (error) {
    logError(error, { endpoint: 'GET /api/videos/:id' });
    res.status(500).json({ error: 'Failed to get video' });
  }
});

/**
 * POST /api/videos
 * Create a new video
 */
router.post('/', async (req, res) => {
  try {
    const { title, description, thumbnail_url, channel_name, category, duration_seconds } =
      req.body;

    if (!title || !channel_name || !category) {
      return res.status(400).json({ error: 'title, channel_name, and category are required' });
    }

    const id = uuidv4();
    const result = await query(
      `INSERT INTO videos (id, title, description, thumbnail_url, channel_name, category, duration_seconds)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [
        id,
        title,
        description || '',
        thumbnail_url || `https://picsum.photos/seed/${id}/320/180`,
        channel_name,
        category,
        duration_seconds || Math.floor(Math.random() * 600) + 60,
      ]
    );

    logger.info({ videoId: id, category }, 'New video created');
    res.status(201).json(result.rows[0]);
  } catch (error) {
    logError(error, { endpoint: 'POST /api/videos' });
    res.status(500).json({ error: 'Failed to create video' });
  }
});

/**
 * POST /api/videos/:id/view
 * Record a view for a video
 *
 * WHY IDEMPOTENCY PREVENTS DUPLICATE VIEW COUNTING:
 * Without idempotency, the same view event can be counted multiple times due to:
 * 1. Network retries: Client retries on timeout, server may have already processed
 * 2. Double-clicks: User accidentally triggers multiple events
 * 3. Client-side bugs: Frontend fires the same event multiple times
 * 4. Load balancer retries: Some LBs retry failed requests
 *
 * Idempotency uses Redis SETNX to atomically check if a request was already
 * processed. The key includes video ID, session ID, and time bucket to:
 * - Prevent exact duplicates (same request retried)
 * - Allow legitimate repeated views (user watches again after an hour)
 * - Handle distributed servers (all servers share Redis state)
 *
 * Headers supported:
 * - X-Request-Id: Unique request identifier for exact deduplication
 * - X-Session-Id: Session identifier for time-bucketed deduplication
 */
router.post('/:id/view', async (req, res) => {
  try {
    const { id } = req.params;
    const requestId = req.headers['x-request-id'];
    const sessionId = req.headers['x-session-id'] || req.body.sessionId;

    // Check if video exists and get category
    const videoResult = await query(
      'SELECT id, category, total_views FROM videos WHERE id = $1',
      [id]
    );

    if (videoResult.rows.length === 0) {
      return res.status(404).json({ error: 'Video not found' });
    }

    const video = videoResult.rows[0];
    const trendingService = TrendingService.getInstance();

    // Process with idempotency check
    const result = await processViewWithIdempotency(
      id,
      video.category,
      { sessionId, requestId },
      async () => {
        await trendingService.recordView(id, video.category);
      }
    );

    if (result.duplicate) {
      // Return success but indicate it was a duplicate
      logger.debug(
        { videoId: id, idempotencyKey: result.key },
        'Duplicate view request ignored'
      );

      return res.status(200).json({
        success: true,
        duplicate: true,
        videoId: id,
        message: 'View already recorded (idempotency)',
        idempotencyKey: result.key,
      });
    }

    res.json({
      success: true,
      duplicate: false,
      videoId: id,
      totalViews: video.total_views + 1,
      idempotencyKey: result.key,
    });
  } catch (error) {
    logError(error, { endpoint: 'POST /api/videos/:id/view' });
    res.status(500).json({ error: 'Failed to record view' });
  }
});

/**
 * POST /api/videos/batch-view
 * Record multiple views at once (for simulation/testing)
 *
 * Note: Batch views bypass idempotency by design (for testing purposes)
 */
router.post('/batch-view', async (req, res) => {
  try {
    const { views } = req.body; // Array of { videoId, count }

    if (!Array.isArray(views)) {
      return res.status(400).json({ error: 'views must be an array' });
    }

    const trendingService = TrendingService.getInstance();
    const results = [];

    for (const { videoId, count = 1 } of views) {
      // Get video category
      const videoResult = await query(
        'SELECT id, category FROM videos WHERE id = $1',
        [videoId]
      );

      if (videoResult.rows.length === 0) {
        results.push({ videoId, error: 'not found' });
        continue;
      }

      const video = videoResult.rows[0];

      // Record views (bypassing idempotency for batch operations)
      for (let i = 0; i < count; i++) {
        await trendingService.recordView(videoId, video.category);
      }

      results.push({ videoId, count, success: true });
    }

    logger.info(
      { viewCount: views.length, totalViews: views.reduce((sum, v) => sum + (v.count || 1), 0) },
      'Batch views recorded'
    );

    res.json({ results });
  } catch (error) {
    logError(error, { endpoint: 'POST /api/videos/batch-view' });
    res.status(500).json({ error: 'Failed to batch record views' });
  }
});

/**
 * GET /api/videos/stats/idempotency
 * Get idempotency statistics (for debugging/monitoring)
 */
router.get('/stats/idempotency', async (req, res) => {
  try {
    const stats = await getIdempotencyStats();
    res.json(stats);
  } catch (error) {
    logError(error, { endpoint: 'GET /api/videos/stats/idempotency' });
    res.status(500).json({ error: 'Failed to get idempotency stats' });
  }
});

export default router;
