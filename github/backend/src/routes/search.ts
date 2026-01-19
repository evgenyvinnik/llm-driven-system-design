import { Router } from 'express';
import * as searchService from '../services/search.js';

const router = Router();

/**
 * Search code
 */
router.get('/code', async (req, res) => {
  const { q, language, repo, owner, path, page = 1, limit = 20 } = req.query;

  if (!q) {
    return res.status(400).json({ error: 'Query required' });
  }

  try {
    const results = await searchService.searchCode(q, {
      language,
      repo,
      owner,
      path,
      page: parseInt(page),
      limit: parseInt(limit),
    });

    res.json(results);
  } catch (err) {
    console.error('Search error:', err);
    res.status(500).json({ error: 'Search failed' });
  }
});

/**
 * Search symbols
 */
router.get('/symbols', async (req, res) => {
  const { q, language, repo, owner, kind, page = 1, limit = 20 } = req.query;

  if (!q) {
    return res.status(400).json({ error: 'Query required' });
  }

  try {
    const results = await searchService.searchSymbols(q, {
      language,
      repo,
      owner,
      kind,
      page: parseInt(page),
      limit: parseInt(limit),
    });

    res.json(results);
  } catch (err) {
    console.error('Symbol search error:', err);
    res.status(500).json({ error: 'Search failed' });
  }
});

/**
 * Combined search (repos, issues, users)
 */
router.get('/', async (req, res) => {
  const { q, type = 'all' } = req.query;

  if (!q) {
    return res.status(400).json({ error: 'Query required' });
  }

  // Import query from db inside function to avoid circular deps
  const { query: dbQuery } = await import('../db/index.js');

  const results = {
    repositories: [],
    issues: [],
    users: [],
  };

  try {
    if (type === 'all' || type === 'repositories') {
      const repos = await dbQuery(
        `SELECT r.*, u.username as owner_name
         FROM repositories r
         JOIN users u ON r.owner_id = u.id
         WHERE r.is_private = FALSE
         AND (r.name ILIKE $1 OR r.description ILIKE $1)
         ORDER BY r.stars_count DESC
         LIMIT 10`,
        [`%${q}%`]
      );
      results.repositories = repos.rows;
    }

    if (type === 'all' || type === 'issues') {
      const issues = await dbQuery(
        `SELECT i.*, r.name as repo_name, u.username as owner_name
         FROM issues i
         JOIN repositories r ON i.repo_id = r.id
         JOIN users u ON r.owner_id = u.id
         WHERE r.is_private = FALSE
         AND (i.title ILIKE $1 OR i.body ILIKE $1)
         ORDER BY i.created_at DESC
         LIMIT 10`,
        [`%${q}%`]
      );
      results.issues = issues.rows;
    }

    if (type === 'all' || type === 'users') {
      const users = await dbQuery(
        `SELECT id, username, display_name, avatar_url, bio
         FROM users
         WHERE username ILIKE $1 OR display_name ILIKE $1
         LIMIT 10`,
        [`%${q}%`]
      );
      results.users = users.rows;
    }

    res.json(results);
  } catch (err) {
    console.error('Search error:', err);
    res.status(500).json({ error: 'Search failed' });
  }
});

export default router;
