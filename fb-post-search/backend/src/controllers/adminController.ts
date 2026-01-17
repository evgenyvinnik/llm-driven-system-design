import type { Response } from 'express';
import type { AuthenticatedRequest } from '../middleware/auth.js';
import { getAllUsers } from '../services/authService.js';
import { getAllPosts, getPostStats } from '../services/postService.js';
import { query } from '../config/database.js';
import { esClient, POSTS_INDEX } from '../config/elasticsearch.js';

// GET /api/v1/admin/stats
export async function getStats(_req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    // Get various stats
    interface CountRow {
      count: string;
    }

    const userCount = await query<CountRow>('SELECT COUNT(*) as count FROM users');
    const postStats = await getPostStats();
    const searchCount = await query<CountRow>('SELECT COUNT(*) as count FROM search_history');

    // Get Elasticsearch stats
    let esStats = null;
    try {
      const esInfo = await esClient.indices.stats({ index: POSTS_INDEX });
      esStats = {
        docs_count: esInfo._all.primaries?.docs?.count || 0,
        store_size_bytes: esInfo._all.primaries?.store?.size_in_bytes || 0,
      };
    } catch {
      // Elasticsearch might not be available
    }

    res.json({
      users: {
        total: parseInt(userCount[0]?.count || '0', 10),
      },
      posts: postStats,
      searches: {
        total: parseInt(searchCount[0]?.count || '0', 10),
      },
      elasticsearch: esStats,
    });
  } catch (error) {
    console.error('Get stats error:', error);
    res.status(500).json({ error: 'Failed to get stats' });
  }
}

// GET /api/v1/admin/users
export async function getUsers(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const { limit, offset } = req.query;

    const users = await getAllUsers(
      Math.min(parseInt(String(limit) || '50', 10), 100),
      parseInt(String(offset) || '0', 10)
    );

    // Remove sensitive data
    const sanitizedUsers = users.map((user) => ({
      id: user.id,
      username: user.username,
      display_name: user.display_name,
      email: user.email,
      role: user.role,
      created_at: user.created_at,
    }));

    res.json({ users: sanitizedUsers });
  } catch (error) {
    console.error('Get users error:', error);
    res.status(500).json({ error: 'Failed to get users' });
  }
}

// GET /api/v1/admin/posts
export async function getPosts(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const { limit, offset } = req.query;

    const posts = await getAllPosts(
      Math.min(parseInt(String(limit) || '50', 10), 100),
      parseInt(String(offset) || '0', 10)
    );

    res.json({ posts });
  } catch (error) {
    console.error('Get posts error:', error);
    res.status(500).json({ error: 'Failed to get posts' });
  }
}

// GET /api/v1/admin/search-history
export async function getSearchHistory(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const { limit, offset } = req.query;

    interface SearchHistoryRow {
      id: string;
      query: string;
      results_count: number;
      created_at: Date;
      user_id: string;
      username: string;
    }

    const history = await query<SearchHistoryRow>(
      `SELECT sh.id, sh.query, sh.results_count, sh.created_at, sh.user_id, u.username
       FROM search_history sh
       JOIN users u ON sh.user_id = u.id
       ORDER BY sh.created_at DESC
       LIMIT $1 OFFSET $2`,
      [
        Math.min(parseInt(String(limit) || '50', 10), 100),
        parseInt(String(offset) || '0', 10),
      ]
    );

    res.json({ history });
  } catch (error) {
    console.error('Get search history error:', error);
    res.status(500).json({ error: 'Failed to get search history' });
  }
}

// POST /api/v1/admin/reindex
export async function reindexPosts(_req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    // Get all posts
    interface PostRow {
      id: string;
    }
    const posts = await query<PostRow>('SELECT id FROM posts');
    const postIds = posts.map((p) => p.id);

    // Bulk reindex
    const { bulkIndexPosts } = await import('../services/indexingService.js');
    await bulkIndexPosts(postIds);

    res.json({
      success: true,
      indexed_count: postIds.length,
    });
  } catch (error) {
    console.error('Reindex error:', error);
    res.status(500).json({ error: 'Failed to reindex posts' });
  }
}

// GET /api/v1/admin/health
export async function healthCheck(_req: AuthenticatedRequest, res: Response): Promise<void> {
  const health: {
    status: string;
    postgres: boolean;
    elasticsearch: boolean;
    redis: boolean;
  } = {
    status: 'ok',
    postgres: false,
    elasticsearch: false,
    redis: false,
  };

  try {
    // Check PostgreSQL
    await query('SELECT 1');
    health.postgres = true;
  } catch {
    health.status = 'degraded';
  }

  try {
    // Check Elasticsearch
    await esClient.ping();
    health.elasticsearch = true;
  } catch {
    health.status = 'degraded';
  }

  try {
    // Check Redis
    const { redis } = await import('../config/redis.js');
    await redis.ping();
    health.redis = true;
  } catch {
    health.status = 'degraded';
  }

  const statusCode = health.status === 'ok' ? 200 : 503;
  res.status(statusCode).json(health);
}
