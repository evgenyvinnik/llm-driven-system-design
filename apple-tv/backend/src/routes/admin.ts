import express, { Request, Response, Router } from 'express';
import * as db from '../db/index.js';
import { client as redis } from '../db/redis.js';
import { isAuthenticated, isAdmin } from '../middleware/auth.js';
import { v4 as uuidv4 } from 'uuid';

const router: Router = express.Router();

interface StatsRow {
  count: string;
  total?: string;
  subscription_tier?: string;
}

interface UserRow {
  id: string;
  email: string;
  name: string;
  role: string;
  subscription_tier: string;
  subscription_expires_at: Date | null;
  created_at: Date;
}

interface ContentRow {
  id: string;
  title: string;
  description: string;
  duration: number;
  content_type: string;
  status: string;
  featured: boolean;
  view_count: number;
  release_date: Date;
  created_at: Date;
}

interface AnalyticsRow {
  id: string;
  title: string;
  content_type: string;
  view_count: number;
  recent_views: number;
}

// Get dashboard stats
router.get('/stats', isAuthenticated, isAdmin, async (req: Request, res: Response): Promise<void> => {
  try {
    // Try cache first
    const cached = await redis.get('admin:stats');
    if (cached) {
      res.json(JSON.parse(cached));
      return;
    }

    const [users, content, views, subscriptions] = await Promise.all([
      db.query<StatsRow>('SELECT COUNT(*) FROM users'),
      db.query<StatsRow>(`SELECT COUNT(*) FROM content WHERE content_type != 'episode'`),
      db.query<StatsRow>('SELECT SUM(view_count) as total FROM content'),
      db.query<StatsRow>(`
        SELECT subscription_tier, COUNT(*) as count
        FROM users
        WHERE subscription_tier != 'free'
          AND subscription_expires_at > NOW()
        GROUP BY subscription_tier
      `)
    ]);

    const stats = {
      totalUsers: parseInt(users.rows[0].count),
      totalContent: parseInt(content.rows[0].count),
      totalViews: parseInt(views.rows[0].total || '0') || 0,
      activeSubscriptions: subscriptions.rows.reduce((acc: Record<string, number>, row: StatsRow) => {
        if (row.subscription_tier) {
          acc[row.subscription_tier] = parseInt(row.count);
        }
        return acc;
      }, {})
    };

    // Cache for 5 minutes
    await redis.setEx('admin:stats', 300, JSON.stringify(stats));

    res.json(stats);
  } catch (error) {
    console.error('Get admin stats error:', error);
    res.status(500).json({ error: 'Failed to get stats' });
  }
});

// Get all users (paginated)
router.get('/users', isAuthenticated, isAdmin, async (req: Request, res: Response): Promise<void> => {
  try {
    const { limit = '20', offset = '0', search } = req.query as Record<string, string>;

    let query = `
      SELECT id, email, name, role, subscription_tier, subscription_expires_at, created_at
      FROM users
    `;
    const params: unknown[] = [];
    let paramIndex = 1;

    if (search) {
      query += ` WHERE email ILIKE $${paramIndex++} OR name ILIKE $${paramIndex++}`;
      params.push(`%${search}%`, `%${search}%`);
    }

    query += ` ORDER BY created_at DESC`;
    query += ` LIMIT $${paramIndex++} OFFSET $${paramIndex++}`;
    params.push(parseInt(limit), parseInt(offset));

    const result = await db.query<UserRow>(query, params);

    const countResult = await db.query<StatsRow>('SELECT COUNT(*) FROM users');

    res.json({
      users: result.rows,
      total: parseInt(countResult.rows[0].count)
    });
  } catch (error) {
    console.error('Get users error:', error);
    res.status(500).json({ error: 'Failed to get users' });
  }
});

// Get all content (paginated, admin view)
router.get('/content', isAuthenticated, isAdmin, async (req: Request, res: Response): Promise<void> => {
  try {
    const { limit = '20', offset = '0', status, type, search } = req.query as Record<string, string>;

    let query = `
      SELECT id, title, description, duration, content_type, status, featured,
             view_count, release_date, created_at
      FROM content
      WHERE content_type != 'episode'
    `;
    const params: unknown[] = [];
    let paramIndex = 1;

    if (status) {
      query += ` AND status = $${paramIndex++}`;
      params.push(status);
    }

    if (type) {
      query += ` AND content_type = $${paramIndex++}`;
      params.push(type);
    }

    if (search) {
      query += ` AND title ILIKE $${paramIndex++}`;
      params.push(`%${search}%`);
    }

    query += ` ORDER BY created_at DESC`;
    query += ` LIMIT $${paramIndex++} OFFSET $${paramIndex++}`;
    params.push(parseInt(limit), parseInt(offset));

    const result = await db.query<ContentRow>(query, params);

    const countResult = await db.query<StatsRow>(`SELECT COUNT(*) FROM content WHERE content_type != 'episode'`);

    res.json({
      content: result.rows,
      total: parseInt(countResult.rows[0].count)
    });
  } catch (error) {
    console.error('Get admin content error:', error);
    res.status(500).json({ error: 'Failed to get content' });
  }
});

interface CreateContentBody {
  title?: string;
  description?: string;
  duration?: number;
  releaseDate?: string;
  contentType?: string;
  rating?: string;
  genres?: string[];
  thumbnailUrl?: string;
  bannerUrl?: string;
  featured?: boolean;
}

// Create content
router.post('/content', isAuthenticated, isAdmin, async (req: Request, res: Response): Promise<void> => {
  try {
    const {
      title,
      description,
      duration,
      releaseDate,
      contentType,
      rating,
      genres,
      thumbnailUrl,
      bannerUrl,
      featured
    } = req.body as CreateContentBody;

    if (!title || !contentType) {
      res.status(400).json({ error: 'Title and content type are required' });
      return;
    }

    const contentId = uuidv4();

    await db.query(`
      INSERT INTO content (id, title, description, duration, release_date, content_type,
                          rating, genres, thumbnail_url, banner_url, featured, status)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'processing')
    `, [
      contentId,
      title,
      description,
      duration || 0,
      releaseDate,
      contentType,
      rating,
      genres || [],
      thumbnailUrl,
      bannerUrl,
      featured || false
    ]);

    res.status(201).json({ id: contentId });
  } catch (error) {
    console.error('Create content error:', error);
    res.status(500).json({ error: 'Failed to create content' });
  }
});

interface UpdateContentBody {
  title?: string;
  description?: string;
  duration?: number;
  releaseDate?: string;
  rating?: string;
  genres?: string[];
  thumbnailUrl?: string;
  bannerUrl?: string;
  featured?: boolean;
  status?: string;
}

// Update content
router.put('/content/:id', isAuthenticated, isAdmin, async (req: Request, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const {
      title,
      description,
      duration,
      releaseDate,
      rating,
      genres,
      thumbnailUrl,
      bannerUrl,
      featured,
      status
    } = req.body as UpdateContentBody;

    await db.query(`
      UPDATE content SET
        title = COALESCE($1, title),
        description = COALESCE($2, description),
        duration = COALESCE($3, duration),
        release_date = COALESCE($4, release_date),
        rating = COALESCE($5, rating),
        genres = COALESCE($6, genres),
        thumbnail_url = COALESCE($7, thumbnail_url),
        banner_url = COALESCE($8, banner_url),
        featured = COALESCE($9, featured),
        status = COALESCE($10, status)
      WHERE id = $11
    `, [title, description, duration, releaseDate, rating, genres, thumbnailUrl, bannerUrl, featured, status, id]);

    // Clear caches
    await redis.del('content:featured');
    await redis.del('content:genres');

    res.json({ success: true });
  } catch (error) {
    console.error('Update content error:', error);
    res.status(500).json({ error: 'Failed to update content' });
  }
});

// Delete content
router.delete('/content/:id', isAuthenticated, isAdmin, async (req: Request, res: Response): Promise<void> => {
  try {
    const { id } = req.params;

    await db.query('DELETE FROM content WHERE id = $1', [id]);

    // Clear caches
    await redis.del('content:featured');
    await redis.del('content:genres');

    res.json({ success: true });
  } catch (error) {
    console.error('Delete content error:', error);
    res.status(500).json({ error: 'Failed to delete content' });
  }
});

// Toggle featured status
router.post('/content/:id/feature', isAuthenticated, isAdmin, async (req: Request, res: Response): Promise<void> => {
  try {
    const { id } = req.params;

    await db.query(`
      UPDATE content SET featured = NOT featured WHERE id = $1
    `, [id]);

    await redis.del('content:featured');

    res.json({ success: true });
  } catch (error) {
    console.error('Toggle featured error:', error);
    res.status(500).json({ error: 'Failed to toggle featured' });
  }
});

// Get viewing analytics
router.get('/analytics/views', isAuthenticated, isAdmin, async (req: Request, res: Response): Promise<void> => {
  try {
    const { days = '7' } = req.query as Record<string, string>;

    const result = await db.query<AnalyticsRow>(`
      SELECT
        c.id,
        c.title,
        c.content_type,
        c.view_count,
        COUNT(wh.id) as recent_views
      FROM content c
      LEFT JOIN watch_history wh ON wh.content_id = c.id
        AND wh.watched_at >= NOW() - INTERVAL '1 day' * $1
      WHERE c.content_type != 'episode'
      GROUP BY c.id
      ORDER BY recent_views DESC
      LIMIT 20
    `, [parseInt(days)]);

    res.json(result.rows);
  } catch (error) {
    console.error('Get view analytics error:', error);
    res.status(500).json({ error: 'Failed to get analytics' });
  }
});

export default router;
