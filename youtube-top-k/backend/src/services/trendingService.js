import { WindowedViewCounter, getRedisClient } from './redis.js';
import { query } from '../models/database.js';
import { TopK } from '../utils/topk.js';

/**
 * TrendingService manages trending video calculations
 * It periodically computes top K videos across different time windows and categories
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
      parseInt(process.env.WINDOW_SIZE_MINUTES || '60', 10),
      1 // 1-minute buckets
    );
    this.topK = parseInt(process.env.TOP_K_SIZE || '10', 10);
    this.updateInterval = parseInt(process.env.UPDATE_INTERVAL_SECONDS || '5', 10) * 1000;
    this.trendingCache = new Map(); // category -> { videos, updatedAt }
    this.sseClients = new Set();
    this.intervalId = null;
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
        console.error('Error updating trending:', error);
      }
    }, this.updateInterval);

    console.log(`Trending service started (update interval: ${this.updateInterval / 1000}s)`);
  }

  /**
   * Stop the trending calculation background job
   */
  stop() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  /**
   * Record a view for a video
   */
  async recordView(videoId, category = 'all') {
    await this.viewCounter.recordView(videoId, category);

    // Also update PostgreSQL total count
    await query(
      'UPDATE videos SET total_views = total_views + 1, updated_at = NOW() WHERE id = $1',
      [videoId]
    );
  }

  /**
   * Update trending videos for all categories
   */
  async updateTrending() {
    const categories = ['all', 'music', 'gaming', 'sports', 'news', 'entertainment', 'education'];

    for (const category of categories) {
      try {
        const trending = await this.calculateTrending(category);
        this.trendingCache.set(category, {
          videos: trending,
          updatedAt: new Date(),
        });
      } catch (error) {
        console.error(`Error calculating trending for ${category}:`, error);
      }
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
      return cached;
    }
    return { videos: [], updatedAt: null };
  }

  /**
   * Register an SSE client for real-time updates
   */
  registerSSEClient(res) {
    this.sseClients.add(res);
    console.log(`SSE client connected. Total: ${this.sseClients.size}`);

    res.on('close', () => {
      this.sseClients.delete(res);
      console.log(`SSE client disconnected. Total: ${this.sseClients.size}`);
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

    for (const client of this.sseClients) {
      try {
        client.write(`data: ${data}\n\n`);
      } catch (error) {
        console.error('Error sending SSE:', error);
        this.sseClients.delete(client);
      }
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

    return {
      totalViews,
      uniqueVideos,
      activeCategories: this.trendingCache.size,
      connectedClients: this.sseClients.size,
      lastUpdate: this.trendingCache.get('all')?.updatedAt || null,
    };
  }
}
