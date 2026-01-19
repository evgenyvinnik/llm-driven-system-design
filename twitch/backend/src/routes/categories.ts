import express, { Request, Response, Router } from 'express';
import { query } from '../services/database.js';

const router: Router = express.Router();

interface CategoryRow {
  id: number;
  name: string;
  slug: string;
  image_url: string | null;
  live_channels: string;
  total_viewers: string;
}

interface ChannelRow {
  id: number;
  name: string;
  title: string;
  is_live: boolean;
  current_viewers: number;
  follower_count: number;
  thumbnail_url: string | null;
  username: string;
  display_name: string;
  avatar_url: string | null;
  category_name: string;
  category_slug: string;
}

interface CategoryParams {
  slug: string;
}

interface PaginationQuery {
  limit?: string;
  offset?: string;
}

// Get all categories
router.get('/', async (req: Request<object, object, object, PaginationQuery>, res: Response): Promise<void> => {
  try {
    const { limit = '50', offset = '0' } = req.query;

    const result = await query<CategoryRow>(`
      SELECT c.id, c.name, c.slug, c.image_url,
             COUNT(ch.id) FILTER (WHERE ch.is_live = TRUE) as live_channels,
             COALESCE(SUM(ch.current_viewers) FILTER (WHERE ch.is_live = TRUE), 0) as total_viewers
      FROM categories c
      LEFT JOIN channels ch ON ch.category_id = c.id
      GROUP BY c.id
      ORDER BY total_viewers DESC, c.name ASC
      LIMIT $1 OFFSET $2
    `, [parseInt(limit), parseInt(offset)]);

    res.json({
      categories: result.rows.map(row => ({
        id: row.id,
        name: row.name,
        slug: row.slug,
        imageUrl: row.image_url,
        liveChannels: parseInt(row.live_channels),
        viewerCount: parseInt(row.total_viewers)
      }))
    });
  } catch (error) {
    console.error('Get categories error:', error);
    res.status(500).json({ error: 'Failed to get categories' });
  }
});

// Get category by slug
router.get('/:slug', async (req: Request<CategoryParams>, res: Response): Promise<void> => {
  try {
    const { slug } = req.params;

    const result = await query<CategoryRow>(`
      SELECT c.id, c.name, c.slug, c.image_url,
             COUNT(ch.id) FILTER (WHERE ch.is_live = TRUE) as live_channels,
             COALESCE(SUM(ch.current_viewers) FILTER (WHERE ch.is_live = TRUE), 0) as total_viewers
      FROM categories c
      LEFT JOIN channels ch ON ch.category_id = c.id
      WHERE c.slug = $1
      GROUP BY c.id
    `, [slug]);

    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Category not found' });
      return;
    }

    const row = result.rows[0];
    res.json({
      category: {
        id: row.id,
        name: row.name,
        slug: row.slug,
        imageUrl: row.image_url,
        liveChannels: parseInt(row.live_channels),
        viewerCount: parseInt(row.total_viewers)
      }
    });
  } catch (error) {
    console.error('Get category error:', error);
    res.status(500).json({ error: 'Failed to get category' });
  }
});

// Get live channels in category
router.get('/:slug/channels', async (req: Request<CategoryParams, object, object, PaginationQuery>, res: Response): Promise<void> => {
  try {
    const { slug } = req.params;
    const { limit = '20', offset = '0' } = req.query;

    const result = await query<ChannelRow>(`
      SELECT c.id, c.name, c.title, c.is_live, c.current_viewers,
             c.follower_count, c.thumbnail_url,
             u.username, u.display_name, u.avatar_url,
             cat.name as category_name, cat.slug as category_slug
      FROM channels c
      JOIN users u ON c.user_id = u.id
      JOIN categories cat ON c.category_id = cat.id
      WHERE cat.slug = $1 AND c.is_live = TRUE
      ORDER BY c.current_viewers DESC
      LIMIT $2 OFFSET $3
    `, [slug, parseInt(limit), parseInt(offset)]);

    res.json({
      channels: result.rows.map(row => ({
        id: row.id,
        name: row.name,
        title: row.title,
        isLive: row.is_live,
        viewerCount: row.current_viewers,
        followerCount: row.follower_count,
        thumbnailUrl: row.thumbnail_url,
        user: {
          username: row.username,
          displayName: row.display_name,
          avatarUrl: row.avatar_url
        },
        category: {
          name: row.category_name,
          slug: row.category_slug
        }
      }))
    });
  } catch (error) {
    console.error('Get category channels error:', error);
    res.status(500).json({ error: 'Failed to get channels' });
  }
});

export default router;
