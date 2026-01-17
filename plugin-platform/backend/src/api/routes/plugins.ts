import { Router, Request, Response } from 'express';
import { query } from '../../shared/db.js';
import { cacheGet, cacheSet } from '../../shared/cache.js';

export const pluginsRouter = Router();

interface PluginRow {
  id: string;
  name: string;
  description: string;
  category: string;
  icon_url: string;
  license: string;
  is_official: boolean;
  install_count: number;
  created_at: Date;
  updated_at: Date;
  author_username: string;
  author_display_name: string;
  latest_version: string;
  average_rating: number;
  review_count: number;
}

// List/search plugins
pluginsRouter.get('/', async (req: Request, res: Response) => {
  try {
    const {
      q,
      category,
      tag,
      sort = 'popular',
      limit = '20',
      offset = '0',
    } = req.query;

    const cacheKey = `plugins:list:${JSON.stringify(req.query)}`;
    const cached = await cacheGet<PluginRow[]>(cacheKey);
    if (cached) {
      res.json({ plugins: cached, cached: true });
      return;
    }

    let whereClause = "WHERE p.status = 'published'";
    const params: unknown[] = [];
    let paramIndex = 1;

    if (q) {
      whereClause += ` AND (p.name ILIKE $${paramIndex} OR p.description ILIKE $${paramIndex})`;
      params.push(`%${q}%`);
      paramIndex++;
    }

    if (category) {
      whereClause += ` AND p.category = $${paramIndex}`;
      params.push(category);
      paramIndex++;
    }

    if (tag) {
      whereClause += ` AND EXISTS (SELECT 1 FROM plugin_tags pt WHERE pt.plugin_id = p.id AND pt.tag = $${paramIndex})`;
      params.push(tag);
      paramIndex++;
    }

    const sortClause = {
      popular: 'p.install_count DESC',
      recent: 'p.created_at DESC',
      updated: 'p.updated_at DESC',
      name: 'p.name ASC',
      rating: 'COALESCE(AVG(r.rating), 0) DESC',
    }[sort as string] || 'p.install_count DESC';

    const sql = `
      SELECT
        p.id,
        p.name,
        p.description,
        p.category,
        p.icon_url,
        p.license,
        p.is_official,
        p.install_count,
        p.created_at,
        p.updated_at,
        u.username as author_username,
        u.display_name as author_display_name,
        (SELECT version FROM plugin_versions WHERE plugin_id = p.id ORDER BY published_at DESC LIMIT 1) as latest_version,
        COALESCE(AVG(r.rating), 0) as average_rating,
        COUNT(DISTINCT r.id) as review_count
      FROM plugins p
      LEFT JOIN users u ON u.id = p.author_id
      LEFT JOIN plugin_reviews r ON r.plugin_id = p.id
      ${whereClause}
      GROUP BY p.id, u.username, u.display_name
      ORDER BY ${sortClause}
      LIMIT $${paramIndex} OFFSET $${paramIndex + 1}
    `;

    params.push(parseInt(limit as string, 10), parseInt(offset as string, 10));

    const result = await query<PluginRow>(sql, params);

    // Get total count
    const countSql = `SELECT COUNT(*) FROM plugins p ${whereClause.replace(/\$\d+/g, (match) => {
      const idx = parseInt(match.slice(1), 10);
      return `$${idx}`;
    })}`;
    const countResult = await query<{ count: string }>(countSql, params.slice(0, -2));
    const total = parseInt(countResult.rows[0]?.count || '0', 10);

    const plugins = result.rows.map((p) => ({
      id: p.id,
      name: p.name,
      description: p.description,
      category: p.category,
      iconUrl: p.icon_url,
      license: p.license,
      isOfficial: p.is_official,
      installCount: p.install_count,
      createdAt: p.created_at,
      updatedAt: p.updated_at,
      author: {
        username: p.author_username,
        displayName: p.author_display_name,
      },
      latestVersion: p.latest_version,
      averageRating: parseFloat(String(p.average_rating)),
      reviewCount: parseInt(String(p.review_count), 10),
    }));

    await cacheSet(cacheKey, plugins, 60); // Cache for 1 minute

    res.json({ plugins, total });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to list plugins' });
  }
});

// Get single plugin details
pluginsRouter.get('/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    const cacheKey = `plugins:detail:${id}`;
    const cached = await cacheGet(cacheKey);
    if (cached) {
      res.json({ plugin: cached, cached: true });
      return;
    }

    const result = await query<PluginRow & { repository_url: string; homepage_url: string }>(
      `SELECT
        p.*,
        u.username as author_username,
        u.display_name as author_display_name,
        COALESCE(AVG(r.rating), 0) as average_rating,
        COUNT(DISTINCT r.id) as review_count
      FROM plugins p
      LEFT JOIN users u ON u.id = p.author_id
      LEFT JOIN plugin_reviews r ON r.plugin_id = p.id
      WHERE p.id = $1 AND p.status = 'published'
      GROUP BY p.id, u.username, u.display_name`,
      [id]
    );

    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Plugin not found' });
      return;
    }

    const p = result.rows[0];

    // Get versions
    const versionsResult = await query<{
      version: string;
      changelog: string;
      published_at: Date;
      file_size: number;
    }>(
      `SELECT version, changelog, published_at, file_size
       FROM plugin_versions
       WHERE plugin_id = $1
       ORDER BY published_at DESC
       LIMIT 10`,
      [id]
    );

    // Get tags
    const tagsResult = await query<{ tag: string }>(
      'SELECT tag FROM plugin_tags WHERE plugin_id = $1',
      [id]
    );

    const plugin = {
      id: p.id,
      name: p.name,
      description: p.description,
      category: p.category,
      iconUrl: p.icon_url,
      license: p.license,
      isOfficial: p.is_official,
      installCount: p.install_count,
      repositoryUrl: p.repository_url,
      homepageUrl: p.homepage_url,
      createdAt: p.created_at,
      updatedAt: p.updated_at,
      author: {
        username: p.author_username,
        displayName: p.author_display_name,
      },
      averageRating: parseFloat(String(p.average_rating)),
      reviewCount: parseInt(String(p.review_count), 10),
      versions: versionsResult.rows.map((v) => ({
        version: v.version,
        changelog: v.changelog,
        publishedAt: v.published_at,
        fileSize: v.file_size,
      })),
      tags: tagsResult.rows.map((t) => t.tag),
    };

    await cacheSet(cacheKey, plugin, 300); // Cache for 5 minutes

    res.json({ plugin });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to get plugin' });
  }
});

// Get plugin manifest/bundle URL
pluginsRouter.get('/:id/download', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { version } = req.query;

    let versionQuery = 'ORDER BY published_at DESC LIMIT 1';
    const params: unknown[] = [id];

    if (version) {
      versionQuery = 'AND version = $2';
      params.push(version);
    }

    const result = await query<{ version: string; bundle_url: string; manifest: object }>(
      `SELECT version, bundle_url, manifest
       FROM plugin_versions
       WHERE plugin_id = $1 ${versionQuery}`,
      params
    );

    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Plugin version not found' });
      return;
    }

    const v = result.rows[0];

    res.json({
      pluginId: id,
      version: v.version,
      bundleUrl: v.bundle_url,
      manifest: v.manifest,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to get plugin download' });
  }
});

// Get plugin reviews
pluginsRouter.get('/:id/reviews', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { limit = '20', offset = '0' } = req.query;

    const result = await query<{
      id: string;
      rating: number;
      title: string;
      comment: string;
      created_at: Date;
      username: string;
      display_name: string;
    }>(
      `SELECT r.id, r.rating, r.title, r.comment, r.created_at, u.username, u.display_name
       FROM plugin_reviews r
       JOIN users u ON u.id = r.user_id
       WHERE r.plugin_id = $1
       ORDER BY r.created_at DESC
       LIMIT $2 OFFSET $3`,
      [id, parseInt(limit as string, 10), parseInt(offset as string, 10)]
    );

    const reviews = result.rows.map((r) => ({
      id: r.id,
      rating: r.rating,
      title: r.title,
      comment: r.comment,
      createdAt: r.created_at,
      author: {
        username: r.username,
        displayName: r.display_name,
      },
    }));

    res.json({ reviews });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to get reviews' });
  }
});

// Get categories
pluginsRouter.get('/meta/categories', async (_req: Request, res: Response) => {
  try {
    const result = await query<{ category: string; count: string }>(
      `SELECT category, COUNT(*) as count
       FROM plugins
       WHERE status = 'published' AND category IS NOT NULL
       GROUP BY category
       ORDER BY count DESC`
    );

    res.json({
      categories: result.rows.map((r) => ({
        id: r.category,
        name: r.category.charAt(0).toUpperCase() + r.category.slice(1),
        count: parseInt(r.count, 10),
      })),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to get categories' });
  }
});
