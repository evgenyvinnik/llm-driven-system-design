const express = require('express');
const pool = require('../db/pool');
const redis = require('../db/redis');
const { requireAdmin } = require('../middleware/auth');

const router = express.Router();

// All admin routes require admin role
router.use(requireAdmin);

// Dashboard stats
router.get('/stats', async (req, res) => {
  try {
    const stats = await pool.query(`
      SELECT
        (SELECT COUNT(*) FROM users) as total_users,
        (SELECT COUNT(*) FROM problems) as total_problems,
        (SELECT COUNT(*) FROM submissions) as total_submissions,
        (SELECT COUNT(*) FROM submissions WHERE status = 'accepted') as accepted_submissions,
        (SELECT COUNT(*) FROM submissions WHERE created_at > NOW() - INTERVAL '24 hours') as submissions_24h,
        (SELECT COUNT(*) FROM users WHERE created_at > NOW() - INTERVAL '24 hours') as new_users_24h
    `);

    // Get submissions by status
    const statusResult = await pool.query(`
      SELECT status, COUNT(*) as count
      FROM submissions
      GROUP BY status
    `);

    // Get problems by difficulty
    const difficultyResult = await pool.query(`
      SELECT difficulty, COUNT(*) as count
      FROM problems
      GROUP BY difficulty
    `);

    res.json({
      overview: stats.rows[0],
      submissionsByStatus: statusResult.rows,
      problemsByDifficulty: difficultyResult.rows
    });
  } catch (error) {
    console.error('Admin stats error:', error);
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

// List all users
router.get('/users', async (req, res) => {
  try {
    const { page = 1, limit = 20, search } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);

    let query = `
      SELECT u.id, u.username, u.email, u.role, u.created_at,
        (SELECT COUNT(*) FROM submissions WHERE user_id = u.id) as submission_count,
        (SELECT COUNT(*) FROM user_problem_status WHERE user_id = u.id AND status = 'solved') as solved_count
      FROM users u
      WHERE 1=1
    `;
    const params = [];

    if (search) {
      params.push(`%${search}%`);
      query += ` AND (u.username ILIKE $${params.length} OR u.email ILIKE $${params.length})`;
    }

    query += ` ORDER BY u.created_at DESC`;
    params.push(parseInt(limit));
    query += ` LIMIT $${params.length}`;
    params.push(offset);
    query += ` OFFSET $${params.length}`;

    const result = await pool.query(query, params);

    const countResult = await pool.query('SELECT COUNT(*) FROM users');

    res.json({
      users: result.rows,
      pagination: {
        total: parseInt(countResult.rows[0].count),
        page: parseInt(page),
        limit: parseInt(limit)
      }
    });
  } catch (error) {
    console.error('List users error:', error);
    res.status(500).json({ error: 'Failed to fetch users' });
  }
});

// Get recent submissions
router.get('/submissions', async (req, res) => {
  try {
    const { page = 1, limit = 50, status, problemId } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);

    let query = `
      SELECT s.id, s.language, s.status, s.runtime_ms, s.created_at,
             u.username, p.title as problem_title, p.slug as problem_slug
      FROM submissions s
      JOIN users u ON s.user_id = u.id
      JOIN problems p ON s.problem_id = p.id
      WHERE 1=1
    `;
    const params = [];

    if (status) {
      params.push(status);
      query += ` AND s.status = $${params.length}`;
    }

    if (problemId) {
      params.push(problemId);
      query += ` AND s.problem_id = $${params.length}`;
    }

    query += ` ORDER BY s.created_at DESC`;
    params.push(parseInt(limit));
    query += ` LIMIT $${params.length}`;
    params.push(offset);
    query += ` OFFSET $${params.length}`;

    const result = await pool.query(query, params);

    res.json({ submissions: result.rows });
  } catch (error) {
    console.error('List submissions error:', error);
    res.status(500).json({ error: 'Failed to fetch submissions' });
  }
});

// Leaderboard
router.get('/leaderboard', async (req, res) => {
  try {
    const { limit = 50 } = req.query;

    const result = await pool.query(`
      SELECT u.id, u.username,
        COUNT(DISTINCT ups.problem_id) FILTER (WHERE ups.status = 'solved') as solved_count,
        COUNT(DISTINCT ups.problem_id) FILTER (WHERE ups.status = 'solved' AND p.difficulty = 'easy') as easy_solved,
        COUNT(DISTINCT ups.problem_id) FILTER (WHERE ups.status = 'solved' AND p.difficulty = 'medium') as medium_solved,
        COUNT(DISTINCT ups.problem_id) FILTER (WHERE ups.status = 'solved' AND p.difficulty = 'hard') as hard_solved,
        COALESCE(AVG(ups.best_runtime_ms) FILTER (WHERE ups.status = 'solved'), 0) as avg_runtime
      FROM users u
      LEFT JOIN user_problem_status ups ON u.id = ups.user_id
      LEFT JOIN problems p ON ups.problem_id = p.id
      GROUP BY u.id, u.username
      HAVING COUNT(DISTINCT ups.problem_id) FILTER (WHERE ups.status = 'solved') > 0
      ORDER BY solved_count DESC, avg_runtime ASC
      LIMIT $1
    `, [parseInt(limit)]);

    res.json({ leaderboard: result.rows });
  } catch (error) {
    console.error('Leaderboard error:', error);
    res.status(500).json({ error: 'Failed to fetch leaderboard' });
  }
});

// Clear caches
router.post('/cache/clear', async (req, res) => {
  try {
    // Clear all problem caches
    const keys = await redis.keys('problem:*');
    if (keys.length > 0) {
      await redis.del(...keys);
    }

    res.json({ message: 'Cache cleared', keysCleared: keys.length });
  } catch (error) {
    console.error('Clear cache error:', error);
    res.status(500).json({ error: 'Failed to clear cache' });
  }
});

module.exports = router;
