import { Router, Request, Response } from 'express';
import { requireAuth, requireWorkspace } from '../middleware/auth.js';
import { searchMessages } from '../services/elasticsearch.js';
import { query } from '../db/index.js';

const router = Router();

// Search messages
router.get('/', requireAuth, requireWorkspace, async (req: Request, res: Response): Promise<void> => {
  try {
    const { q, channel_id, user_id, from_date, to_date, limit = '50' } = req.query;
    const workspaceId = req.session.workspaceId!;

    if (!q || typeof q !== 'string' || q.trim() === '') {
      res.status(400).json({ error: 'Search query is required' });
      return;
    }

    // Try Elasticsearch first
    try {
      const results = await searchMessages(
        workspaceId,
        q.trim(),
        {
          channel_id: channel_id as string | undefined,
          user_id: user_id as string | undefined,
          from_date: from_date as string | undefined,
          to_date: to_date as string | undefined,
        },
        parseInt(limit as string, 10)
      );

      // Enrich results with user info
      const enrichedResults = await Promise.all(
        results.map(async (result) => {
          const userResult = await query(
            'SELECT username, display_name, avatar_url FROM users WHERE id = $1',
            [result.user_id]
          );

          const channelResult = await query(
            'SELECT name FROM channels WHERE id = $1',
            [result.channel_id]
          );

          return {
            ...result,
            user: userResult.rows[0] || null,
            channel_name: channelResult.rows[0]?.name || null,
          };
        })
      );

      res.json(enrichedResults);
      return;
    } catch (esError) {
      console.warn('Elasticsearch unavailable, falling back to PostgreSQL:', esError);
    }

    // Fallback to PostgreSQL full-text search
    let searchQuery = `
      SELECT m.id, m.channel_id, m.user_id, m.content, m.created_at,
        u.username, u.display_name, u.avatar_url,
        c.name as channel_name,
        ts_headline('english', m.content, plainto_tsquery('english', $1)) as highlight
      FROM messages m
      INNER JOIN users u ON u.id = m.user_id
      INNER JOIN channels c ON c.id = m.channel_id
      WHERE m.workspace_id = $2
        AND to_tsvector('english', m.content) @@ plainto_tsquery('english', $1)
    `;

    const params: unknown[] = [q.trim(), workspaceId];
    let paramIndex = 3;

    if (channel_id) {
      searchQuery += ` AND m.channel_id = $${paramIndex}`;
      params.push(channel_id);
      paramIndex++;
    }

    if (user_id) {
      searchQuery += ` AND m.user_id = $${paramIndex}`;
      params.push(user_id);
      paramIndex++;
    }

    if (from_date) {
      searchQuery += ` AND m.created_at >= $${paramIndex}`;
      params.push(from_date);
      paramIndex++;
    }

    if (to_date) {
      searchQuery += ` AND m.created_at <= $${paramIndex}`;
      params.push(to_date);
      paramIndex++;
    }

    searchQuery += ` ORDER BY m.created_at DESC LIMIT $${paramIndex}`;
    params.push(parseInt(limit as string, 10));

    const result = await query(searchQuery, params);

    res.json(result.rows.map(row => ({
      id: row.id,
      channel_id: row.channel_id,
      user_id: row.user_id,
      content: row.content,
      created_at: row.created_at,
      highlight: row.highlight ? [row.highlight] : undefined,
      user: {
        username: row.username,
        display_name: row.display_name,
        avatar_url: row.avatar_url,
      },
      channel_name: row.channel_name,
    })));
  } catch (error) {
    console.error('Search error:', error);
    res.status(500).json({ error: 'Search failed' });
  }
});

export default router;
