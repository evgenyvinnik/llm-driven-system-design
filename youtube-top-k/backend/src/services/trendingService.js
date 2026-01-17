import { WindowedViewCounter, getRedisClient } from './redis.js';
import { query } from '../models/database.js';
import { TopK } from '../utils/topk.js';

// Import shared modules
import { WINDOW_CONFIG, TOP_K_CONFIG, CACHE_CONFIG, RETENTION_CONFIG } from '../shared/config.js';
import logger, { logTrendingCalculation, logCacheAccess, logViewEvent, logError } from '../shared/logger.js';
import {
  viewEventsTotal,
  viewEventLatency,
  trendingCalculationsTotal,
  trendingCalculationLatency,
  trendingVideosCount,
  lastTrendingUpdate,
  recordCacheAccess,
  sseClientsConnected,
  sseConnectionsTotal,
  redisBucketKeyCount,
} from '../shared/metrics.js';

/**
 * TrendingService manages trending video calculations
 * It periodically computes top K videos across different time windows and categories
 *
 * WHY SLIDING WINDOW RETENTION BALANCES TRENDING ACCURACY VS MEMORY:
 * - Shorter windows (e.g., 15 min) capture immediate viral content but are noisy
 * - Longer windows (e.g., 24 hours) are stable but miss fast-rising content
 * - The default 60-minute window balances these tradeoffs
 * - Time bucketing (1-min buckets) enables efficient sliding window computation
 * - Redis TTL automatically cleans up old buckets, preventing memory growth
 *
 * WHY CACHE HIT RATES DRIVE TOP-K UPDATE FREQUENCY:
 * - High cache hit rate (>95%) means clients mostly read cached data
 * - This allows us to reduce update frequency without impacting freshness
 * - Low hit rate suggests update interval may be too long
 * - Metrics help tune the balance between accuracy and compute cost
 */
export class TrendingService {
  static instance = null;

  static getInstance() {
    if (!TrendingService.instance) {
      TrendingService.instance = new TrendingService();
    }
    return TrendingService.instance;
  }

  constructor() {
    this.viewCounter = new WindowedViewCounter(
      WINDOW_CONFIG.windowSizeMinutes,
      WINDOW_CONFIG.bucketSizeMinutes
    );
    this.topK = TOP_K_CONFIG.defaultK;
    this.updateInterval = TOP_K_CONFIG.updateIntervalSeconds * 1000;
    this.trendingCache = new Map(); // category -> { videos, updatedAt }
    this.trendingCacheTimestamps = new Map(); // category -> last access time
    this.sseClients = new Set();
    this.intervalId = null;

    // Cache access tracking for hit rate calculation
    this.cacheAccesses = { hits: 0, misses: 0 };

    logger.info(
      {
        windowMinutes: WINDOW_CONFIG.windowSizeMinutes,
        bucketMinutes: WINDOW_CONFIG.bucketSizeMinutes,
        topK: this.topK,
        updateIntervalMs: this.updateInterval,
      },
      'TrendingService initialized with configuration'
    );
  }

  /**
   * Start the trending calculation background job
   */
  async start() {
    // Initial calculation
    await this.updateTrending();

    // Periodic updates
    this.intervalId = setInterval(async () => {
      try {
        await this.updateTrending();
      } catch (error) {
        logError(error, { context: 'trending_update' });
      }
    }, this.updateInterval);

    logger.info(
      { updateIntervalSeconds: this.updateInterval / 1000 },
      'Trending service started'
    );
  }

  /**
   * Stop the trending calculation background job
   */
  stop() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
      logger.info('Trending service stopped');
    }
  }

  /**
   * Record a view for a video
   */
  async recordView(videoId, category = 'all') {
    const start = process.hrtime.bigint();

    try {
      await this.viewCounter.recordView(videoId, category);

      // Also update PostgreSQL total count
      await query(
        'UPDATE videos SET total_views = total_views + 1, updated_at = NOW() WHERE id = $1',
        [videoId]
      );

      // Optionally log view event to PostgreSQL (based on retention config)
      if (RETENTION_CONFIG.enableViewEventLogging) {
        // Sample views to reduce storage
        if (Math.random() < RETENTION_CONFIG.viewEventSampleRate) {
          await query(
            'INSERT INTO view_events (video_id, viewed_at) VALUES ($1, NOW())',
            [videoId]
          );
        }
      }

      // Record metrics
      const duration = Number(process.hrtime.bigint() - start) / 1e9;
      viewEventsTotal.inc({ category: category || 'all', status: 'success' });
      viewEventLatency.observe({ category: category || 'all' }, duration);

      logViewEvent(videoId, category, { durationMs: duration * 1000 });
    } catch (error) {
      viewEventsTotal.inc({ category: category || 'all', status: 'error' });
      throw error;
    }
  }

  /**
   * Update trending videos for all categories
   */
  async updateTrending() {
    const categories = ['all', 'music', 'gaming', 'sports', 'news', 'entertainment', 'education'];

    for (const category of categories) {
      try {
        const start = process.hrtime.bigint();

        const trending = await this.calculateTrending(category);
        this.trendingCache.set(category, {
          videos: trending,
          updatedAt: new Date(),
        });

        // Record metrics
        const duration = Number(process.hrtime.bigint() - start) / 1e9;
        trendingCalculationsTotal.inc({ category });
        trendingCalculationLatency.observe({ category }, duration);
        trendingVideosCount.set({ category }, trending.length);
        lastTrendingUpdate.set({ category }, Date.now() / 1000);

        logTrendingCalculation(category, trending.length, duration * 1000);
      } catch (error) {
        logError(error, { context: 'trending_calculation', category });
      }
    }

    // Update Redis bucket key counts for monitoring
    try {
      const client = await getRedisClient();
      for (const category of categories) {
        const pattern = `views:bucket:${category}:*`;
        const keys = await client.keys(pattern);
        redisBucketKeyCount.set({ category }, keys.length);
      }
    } catch (error) {
      logError(error, { context: 'redis_key_count' });
    }

    // Notify SSE clients
    this.notifyClients();
  }

  /**
   * Calculate trending videos for a category
   */
  async calculateTrending(category = 'all') {
    // Get top K from windowed counts
    const topVideos = await this.viewCounter.getTopK(this.topK, category);

    if (topVideos.length === 0) {
      return [];
    }

    // Fetch video details from PostgreSQL
    const videoIds = topVideos.map((v) => v.videoId);
    const placeholders = videoIds.map((_, i) => `$${i + 1}`).join(',');

    const result = await query(
      `SELECT id, title, description, thumbnail_url, channel_name, category,
              duration_seconds, total_views, created_at
       FROM videos
       WHERE id IN (${placeholders})`,
      videoIds
    );

    // Build a map for quick lookup
    const videoMap = new Map(result.rows.map((v) => [v.id, v]));

    // Merge view counts with video details
    const trendingVideos = topVideos
      .map((item) => {
        const video = videoMap.get(item.videoId);
        if (!video) return null;
        return {
          ...video,
          windowViews: item.viewCount,
          rank: topVideos.indexOf(item) + 1,
        };
      })
      .filter(Boolean);

    return trendingVideos;
  }

  /**
   * Get cached trending videos for a category
   */
  getTrending(category = 'all') {
    const cached = this.trendingCache.get(category);

    if (cached) {
      // Check if cache is still fresh
      const age = Date.now() - cached.updatedAt.getTime();
      const isFresh = age < CACHE_CONFIG.trendingCacheTtlSeconds * 1000;

      // Record cache access
      recordCacheAccess('trending', true);
      logCacheAccess('trending', true, category);

      return cached;
    }

    // Cache miss
    recordCacheAccess('trending', false);
    logCacheAccess('trending', false, category);

    return { videos: [], updatedAt: null };
  }

  /**
   * Register an SSE client for real-time updates
   */
  registerSSEClient(res) {
    this.sseClients.add(res);

    // Update metrics
    sseClientsConnected.set(this.sseClients.size);
    sseConnectionsTotal.inc({ status: 'connected' });

    logger.info(
      { clientCount: this.sseClients.size },
      'SSE client connected'
    );

    res.on('close', () => {
      this.sseClients.delete(res);
      sseClientsConnected.set(this.sseClients.size);
      sseConnectionsTotal.inc({ status: 'disconnected' });

      logger.info(
        { clientCount: this.sseClients.size },
        'SSE client disconnected'
      );
    });
  }

  /**
   * Notify all SSE clients of trending updates
   */
  notifyClients() {
    const data = JSON.stringify({
      type: 'trending-update',
      timestamp: new Date().toISOString(),
      trending: Object.fromEntries(
        Array.from(this.trendingCache.entries()).map(([category, data]) => [
          category,
          { videos: data.videos, updatedAt: data.updatedAt },
        ])
      ),
    });

    let errorCount = 0;
    for (const client of this.sseClients) {
      try {
        client.write(`data: ${data}\n\n`);
      } catch (error) {
        logError(error, { context: 'sse_send' });
        this.sseClients.delete(client);
        sseConnectionsTotal.inc({ status: 'error' });
        errorCount++;
      }
    }

    if (errorCount > 0) {
      sseClientsConnected.set(this.sseClients.size);
    }
  }

  /**
   * Get available categories
   */
  async getCategories() {
    const result = await query(
      'SELECT DISTINCT category FROM videos ORDER BY category'
    );
    return result.rows.map((r) => r.category);
  }

  /**
   * Get trending statistics
   */
  async getStats() {
    const client = await getRedisClient();

    // Get total view count from hash
    const totalViewsHash = await client.hGetAll('views:total');
    const totalViews = Object.values(totalViewsHash).reduce(
      (sum, count) => sum + parseInt(count, 10),
      0
    );

    // Get unique videos with views
    const uniqueVideos = Object.keys(totalViewsHash).length;

    // Calculate cache hit rate
    const totalAccesses = this.cacheAccesses.hits + this.cacheAccesses.misses;
    const cacheHitRate = totalAccesses > 0
      ? this.cacheAccesses.hits / totalAccesses
      : 0;

    return {
      totalViews,
      uniqueVideos,
      activeCategories: this.trendingCache.size,
      connectedClients: this.sseClients.size,
      lastUpdate: this.trendingCache.get('all')?.updatedAt || null,
      cacheHitRate: cacheHitRate.toFixed(3),
      config: {
        windowMinutes: WINDOW_CONFIG.windowSizeMinutes,
        topK: this.topK,
        updateIntervalSeconds: TOP_K_CONFIG.updateIntervalSeconds,
      },
    };
  }
}
