import { Router, type Request, type Response } from 'express';
import pool from '../db/pool.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();

interface UserParams {
  id: string;
}

interface PaginationQuery {
  page?: string;
  limit?: string;
}

// Get user profile and stats
router.get('/:id/profile', async (req: Request<UserParams>, res: Response): Promise<void> => {
  try {
    const { id } = req.params;

    const userResult = await pool.query(
      `SELECT id, username, created_at FROM users WHERE id = $1`,
      [id]
    );

    if (userResult.rows.length === 0) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    const user = userResult.rows[0];

    // Get stats
    const statsResult = await pool.query(
      `SELECT
        (SELECT COUNT(*) FROM user_problem_status WHERE user_id = $1 AND status = 'solved') as solved_count,
        (SELECT COUNT(*) FROM user_problem_status WHERE user_id = $1 AND status = 'attempted') as attempted_count,
        (SELECT COUNT(*) FROM submissions WHERE user_id = $1) as total_submissions,
        (SELECT COUNT(*) FROM submissions WHERE user_id = $1 AND status = 'accepted') as accepted_submissions
      `,
      [id]
    );

    // Get difficulty breakdown
    const difficultyResult = await pool.query(
      `SELECT p.difficulty, COUNT(*) as count
       FROM user_problem_status ups
       JOIN problems p ON ups.problem_id = p.id
       WHERE ups.user_id = $1 AND ups.status = 'solved'
       GROUP BY p.difficulty`,
      [id]
    );

    const difficultyBreakdown: Record<string, number> = {
      easy: 0,
      medium: 0,
      hard: 0
    };
    difficultyResult.rows.forEach(row => {
      difficultyBreakdown[row.difficulty] = parseInt(row.count);
    });

    res.json({
      user,
      stats: {
        ...statsResult.rows[0],
        difficultyBreakdown
      }
    });
  } catch (error) {
    console.error('Get user profile error:', error);
    res.status(500).json({ error: 'Failed to fetch user profile' });
  }
});

// Get user's submission history
router.get('/:id/submissions', async (req: Request<UserParams, unknown, unknown, PaginationQuery>, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const { page = '1', limit = '20' } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);

    const result = await pool.query(
      `SELECT s.id, s.language, s.status, s.runtime_ms, s.memory_kb,
              s.test_cases_passed, s.test_cases_total, s.created_at,
              p.title as problem_title, p.slug as problem_slug, p.difficulty
       FROM submissions s
       JOIN problems p ON s.problem_id = p.id
       WHERE s.user_id = $1
       ORDER BY s.created_at DESC
       LIMIT $2 OFFSET $3`,
      [id, parseInt(limit), offset]
    );

    const countResult = await pool.query(
      'SELECT COUNT(*) FROM submissions WHERE user_id = $1',
      [id]
    );

    res.json({
      submissions: result.rows,
      pagination: {
        total: parseInt(countResult.rows[0].count),
        page: parseInt(page),
        limit: parseInt(limit)
      }
    });
  } catch (error) {
    console.error('Get user submissions error:', error);
    res.status(500).json({ error: 'Failed to fetch submissions' });
  }
});

// Get user's solved problems
router.get('/:id/solved', async (req: Request<UserParams>, res: Response): Promise<void> => {
  try {
    const { id } = req.params;

    const result = await pool.query(
      `SELECT p.id, p.title, p.slug, p.difficulty, ups.best_runtime_ms, ups.solved_at
       FROM user_problem_status ups
       JOIN problems p ON ups.problem_id = p.id
       WHERE ups.user_id = $1 AND ups.status = 'solved'
       ORDER BY ups.solved_at DESC`,
      [id]
    );

    res.json({ problems: result.rows });
  } catch (error) {
    console.error('Get solved problems error:', error);
    res.status(500).json({ error: 'Failed to fetch solved problems' });
  }
});

// Get current user's progress
router.get('/me/progress', requireAuth, async (req: Request, res: Response): Promise<void> => {
  try {
    const result = await pool.query(
      `SELECT ups.problem_id, p.slug, p.title, p.difficulty, ups.status, ups.attempts, ups.best_runtime_ms
       FROM user_problem_status ups
       JOIN problems p ON ups.problem_id = p.id
       WHERE ups.user_id = $1
       ORDER BY p.difficulty, p.title`,
      [req.session.userId]
    );

    // Get totals per difficulty
    const totalsResult = await pool.query(
      `SELECT difficulty, COUNT(*) as count FROM problems GROUP BY difficulty`
    );

    const totals: Record<string, number> = {
      easy: 0,
      medium: 0,
      hard: 0
    };
    totalsResult.rows.forEach(row => {
      totals[row.difficulty] = parseInt(row.count);
    });

    res.json({
      progress: result.rows,
      totals
    });
  } catch (error) {
    console.error('Get progress error:', error);
    res.status(500).json({ error: 'Failed to fetch progress' });
  }
});

export default router;
