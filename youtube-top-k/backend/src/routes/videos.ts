import express, { Request, Response, Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { query } from '../models/database.js';
import { TrendingService } from '../services/trendingService.js';
import { processViewWithIdempotency, getIdempotencyStats } from '../services/idempotency.js';
import logger, { logError } from '../shared/logger.js';

const router: Router = express.Router();

interface VideoRow {
  id: string;
  title: string;
  description: string;
  thumbnail_url: string;
  channel_name: string;
  category: string;
  duration_seconds: number;
  total_views: number;
  created_at: Date;
}

interface CountRow {
  count: string;
}

interface BatchViewItem {
  videoId: string;
  count?: number;
}

interface BatchViewResult {
  videoId: string;
  count?: number;
  success?: boolean;
  error?: string;
}

/**
 * GET /api/videos
 * List all videos with pagination
 */
router.get('/', async (req: Request, res: Response): Promise<void> => {
  try {
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 20;
    const category = req.query.category as string | undefined;
    const offset = (page - 1) * limit;

    let sql = `
      SELECT id, title, description, thumbnail_url, channel_name, category,
             duration_seconds, total_views, created_at
      FROM videos
    `;
    const params: (string | number)[] = [];

    if (category && category !== 'all') {
      sql += ' WHERE category = $1';
      params.push(category);
    }

    sql += ' ORDER BY created_at DESC';
    sql += ` LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    params.push(limit, offset);

    const result = await query<VideoRow>(sql, params);

    // Get total count
    let countSql = 'SELECT COUNT(*) FROM videos';
    const countParams: string[] = [];
    if (category && category !== 'all') {
      countSql += ' WHERE category = $1';
      countParams.push(category);
    }
    const countResult = await query<CountRow>(countSql, countParams);

    res.json({
      videos: result.rows,
      pagination: {
        page,
        limit,
        total: parseInt(countResult.rows[0].count),
        totalPages: Math.ceil(parseInt(countResult.rows[0].count) / limit),
      },
    });
  } catch (error) {
    logError(error as Error, { endpoint: 'GET /api/videos' });
    res.status(500).json({ error: 'Failed to list videos' });
  }
});

/**
 * GET /api/videos/:id
 * Get a single video by ID
 */
router.get('/:id', async (req: Request, res: Response): Promise<void> => {
  try {
    const { id } = req.params;

    const result = await query<VideoRow>(
      `SELECT id, title, description, thumbnail_url, channel_name, category,
              duration_seconds, total_views, created_at
       FROM videos WHERE id = $1`,
      [id]
    );

    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Video not found' });
      return;
    }

    res.json(result.rows[0]);
  } catch (error) {
    logError(error as Error, { endpoint: 'GET /api/videos/:id' });
    res.status(500).json({ error: 'Failed to get video' });
  }
});

/**
 * POST /api/videos
 * Create a new video
 */
router.post('/', async (req: Request, res: Response): Promise<void> => {
  try {
    const { title, description, thumbnail_url, channel_name, category, duration_seconds } =
      req.body as {
        title?: string;
        description?: string;
        thumbnail_url?: string;
        channel_name?: string;
        category?: string;
        duration_seconds?: number;
      };

    if (!title || !channel_name || !category) {
      res.status(400).json({ error: 'title, channel_name, and category are required' });
      return;
    }

    const id = uuidv4();
    const result = await query<VideoRow>(
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
    logError(error as Error, { endpoint: 'POST /api/videos' });
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
router.post('/:id/view', async (req: Request, res: Response): Promise<void> => {
  try {
    const id = req.params.id as string;
    const rawRequestId = req.headers['x-request-id'];
    const requestId: string | undefined = Array.isArray(rawRequestId) ? rawRequestId[0] : rawRequestId;
    const rawSessionId = req.headers['x-session-id'];
    const bodySessionId = (req.body as { sessionId?: string }).sessionId;
    const sessionId: string | undefined = Array.isArray(rawSessionId) ? rawSessionId[0] : (rawSessionId || bodySessionId);

    // Check if video exists and get category
    const videoResult = await query<{ id: string; category: string; total_views: number }>(
      'SELECT id, category, total_views FROM videos WHERE id = $1',
      [id]
    );

    if (videoResult.rows.length === 0) {
      res.status(404).json({ error: 'Video not found' });
      return;
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

      res.status(200).json({
        success: true,
        duplicate: true,
        videoId: id,
        message: 'View already recorded (idempotency)',
        idempotencyKey: result.key,
      });
      return;
    }

    res.json({
      success: true,
      duplicate: false,
      videoId: id,
      totalViews: video.total_views + 1,
      idempotencyKey: result.key,
    });
  } catch (error) {
    logError(error as Error, { endpoint: 'POST /api/videos/:id/view' });
    res.status(500).json({ error: 'Failed to record view' });
  }
});

/**
 * POST /api/videos/batch-view
 * Record multiple views at once (for simulation/testing)
 *
 * Note: Batch views bypass idempotency by design (for testing purposes)
 */
router.post('/batch-view', async (req: Request, res: Response): Promise<void> => {
  try {
    const { views } = req.body as { views?: BatchViewItem[] }; // Array of { videoId, count }

    if (!Array.isArray(views)) {
      res.status(400).json({ error: 'views must be an array' });
      return;
    }

    const trendingService = TrendingService.getInstance();
    const results: BatchViewResult[] = [];

    for (const { videoId, count = 1 } of views) {
      // Get video category
      const videoResult = await query<{ id: string; category: string }>(
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
    logError(error as Error, { endpoint: 'POST /api/videos/batch-view' });
    res.status(500).json({ error: 'Failed to batch record views' });
  }
});

/**
 * GET /api/videos/stats/idempotency
 * Get idempotency statistics (for debugging/monitoring)
 */
router.get('/stats/idempotency', async (req: Request, res: Response): Promise<void> => {
  try {
    const stats = await getIdempotencyStats();
    res.json(stats);
  } catch (error) {
    logError(error as Error, { endpoint: 'GET /api/videos/stats/idempotency' });
    res.status(500).json({ error: 'Failed to get idempotency stats' });
  }
});

export default router;
