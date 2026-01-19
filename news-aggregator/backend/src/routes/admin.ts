/**
 * Admin API routes.
 * Provides endpoints for administrative functions including source management,
 * crawl control, and system statistics.
 * All routes require admin role authentication.
 * @module routes/admin
 */

import { Router, Request, Response } from 'express';
import { query, execute } from '../db/postgres.js';
import { crawlAllDueSources, _getAllSources, addSource, crawlSource } from '../services/crawler.js';

const router = Router();

/**
 * Middleware to require admin role.
 * Returns 403 if user is not authenticated as admin.
 */
const requireAdmin = (req: Request, res: Response, next: () => void) => {
  const session = req.session as { role?: string } | undefined;
  if (session?.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
};

/**
 * GET /stats - Get admin dashboard statistics
 * Returns counts of sources, articles, stories, users, and recent article activity.
 */
router.get('/stats', requireAdmin, async (_req: Request, res: Response) => {
  try {
    const [
      sourcesResult,
      articlesResult,
      storiesResult,
      usersResult,
      recentArticlesResult,
    ] = await Promise.all([
      query<{ count: number }>('SELECT COUNT(*) as count FROM sources WHERE is_active = true', []),
      query<{ count: number }>('SELECT COUNT(*) as count FROM articles', []),
      query<{ count: number }>('SELECT COUNT(*) as count FROM stories', []),
      query<{ count: number }>('SELECT COUNT(*) as count FROM users', []),
      query<{ count: number }>(
        'SELECT COUNT(*) as count FROM articles WHERE created_at > NOW() - INTERVAL \'24 hours\'',
        []
      ),
    ]);

    res.json({
      sources: sourcesResult[0]?.count || 0,
      articles: articlesResult[0]?.count || 0,
      stories: storiesResult[0]?.count || 0,
      users: usersResult[0]?.count || 0,
      articles_last_24h: recentArticlesResult[0]?.count || 0,
    });
  } catch (error) {
    console.error('Error getting stats:', error);
    res.status(500).json({ error: 'Failed to get stats' });
  }
});

/**
 * GET /sources - Get all news sources
 * Returns source configurations with crawl schedule information.
 */
router.get('/sources', requireAdmin, async (_req: Request, res: Response) => {
  try {
    const sources = await query(
      `SELECT s.*, cs.next_crawl, cs.priority
       FROM sources s
       LEFT JOIN crawl_schedule cs ON s.id = cs.source_id
       ORDER BY s.name`,
      []
    );
    res.json({ sources });
  } catch (error) {
    console.error('Error getting sources:', error);
    res.status(500).json({ error: 'Failed to get sources' });
  }
});

/**
 * POST /sources - Add a new news source
 * Creates a source and schedules it for immediate crawling.
 */
router.post('/sources', requireAdmin, async (req: Request, res: Response) => {
  try {
    const { name, feed_url, category } = req.body;

    if (!name || !feed_url) {
      return res.status(400).json({ error: 'Missing name or feed_url' });
    }

    const source = await addSource(name, feed_url, category || 'general');
    res.status(201).json(source);
  } catch (error) {
    console.error('Error adding source:', error);
    res.status(500).json({ error: 'Failed to add source' });
  }
});

/**
 * PUT /sources/:id - Update a news source
 * Updates source configuration including name, URL, category, and status.
 */
router.put('/sources/:id', requireAdmin, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { name, feed_url, category, is_active, crawl_frequency_minutes } = req.body;

    await execute(
      `UPDATE sources SET
        name = COALESCE($1, name),
        feed_url = COALESCE($2, feed_url),
        category = COALESCE($3, category),
        is_active = COALESCE($4, is_active),
        crawl_frequency_minutes = COALESCE($5, crawl_frequency_minutes),
        updated_at = NOW()
       WHERE id = $6`,
      [name, feed_url, category, is_active, crawl_frequency_minutes, id]
    );

    res.json({ message: 'Source updated' });
  } catch (error) {
    console.error('Error updating source:', error);
    res.status(500).json({ error: 'Failed to update source' });
  }
});

/**
 * DELETE /sources/:id - Delete a news source
 * Removes the source from the system (articles remain).
 */
router.delete('/sources/:id', requireAdmin, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    await execute('DELETE FROM sources WHERE id = $1', [id]);
    res.json({ message: 'Source deleted' });
  } catch (error) {
    console.error('Error deleting source:', error);
    res.status(500).json({ error: 'Failed to delete source' });
  }
});

/**
 * POST /sources/:id/crawl - Manually trigger crawl for a source
 * Immediately crawls the specified source and returns results.
 */
router.post('/sources/:id/crawl', requireAdmin, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    const sources = await query<{
      id: string;
      name: string;
      domain: string;
      feed_url: string;
      category: string;
      crawl_frequency_minutes: number;
    }>(
      'SELECT id, name, domain, feed_url, category, crawl_frequency_minutes FROM sources WHERE id = $1',
      [id]
    );

    if (sources.length === 0) {
      return res.status(404).json({ error: 'Source not found' });
    }

    const result = await crawlSource(sources[0]);
    res.json(result);
  } catch (error) {
    console.error('Error crawling source:', error);
    res.status(500).json({ error: 'Failed to crawl source' });
  }
});

/**
 * POST /crawl - Trigger full crawl of all due sources
 * Crawls all sources that are scheduled for refresh.
 * Returns summary of crawl results.
 */
router.post('/crawl', requireAdmin, async (_req: Request, res: Response) => {
  try {
    const results = await crawlAllDueSources();
    res.json({
      message: 'Crawl completed',
      sources_crawled: results.length,
      total_articles_found: results.reduce((sum, r) => sum + r.articles_found, 0),
      total_articles_new: results.reduce((sum, r) => sum + r.articles_new, 0),
      errors: results.flatMap(r => r.errors),
    });
  } catch (error) {
    console.error('Error crawling:', error);
    res.status(500).json({ error: 'Failed to crawl sources' });
  }
});

/**
 * GET /articles - Get recent articles
 * Returns paginated list of articles for review.
 */
router.get('/articles', requireAdmin, async (req: Request, res: Response) => {
  try {
    const limit = parseInt(req.query.limit as string) || 50;
    const offset = parseInt(req.query.offset as string) || 0;

    const articles = await query(
      `SELECT a.id, a.title, a.url, a.published_at, a.created_at,
              s.name as source_name, st.title as story_title
       FROM articles a
       JOIN sources s ON a.source_id = s.id
       LEFT JOIN stories st ON a.story_id = st.id
       ORDER BY a.created_at DESC
       LIMIT $1 OFFSET $2`,
      [limit, offset]
    );

    res.json({ articles });
  } catch (error) {
    console.error('Error getting articles:', error);
    res.status(500).json({ error: 'Failed to get articles' });
  }
});

/**
 * GET /breaking-candidates - Get potential breaking news stories
 * Returns stories with high velocity that may warrant breaking news status.
 */
router.get('/breaking-candidates', requireAdmin, async (_req: Request, res: Response) => {
  try {
    const stories = await query(
      `SELECT id, title, velocity, article_count, source_count, is_breaking, created_at
       FROM stories
       WHERE velocity > 0.3 OR is_breaking = true
       ORDER BY velocity DESC
       LIMIT 20`,
      []
    );
    res.json({ stories });
  } catch (error) {
    console.error('Error getting breaking candidates:', error);
    res.status(500).json({ error: 'Failed to get breaking candidates' });
  }
});

/**
 * POST /stories/:id/breaking - Set story breaking news status
 * Marks or unmarks a story as breaking news.
 */
router.post('/stories/:id/breaking', requireAdmin, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { is_breaking } = req.body;

    await execute(
      `UPDATE stories SET
        is_breaking = $1,
        breaking_started_at = CASE WHEN $1 THEN NOW() ELSE NULL END,
        updated_at = NOW()
       WHERE id = $2`,
      [is_breaking, id]
    );

    res.json({ message: 'Story updated' });
  } catch (error) {
    console.error('Error updating story:', error);
    res.status(500).json({ error: 'Failed to update story' });
  }
});

export default router;
