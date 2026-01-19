import { Router, type Request, type Response } from 'express';
import pool from '../db/pool.js';
import redis from '../db/redis.js';
import { requireAuth, requireAdmin } from '../middleware/auth.js';

const router = Router();

interface ListQuery {
  difficulty?: string;
  search?: string;
  page?: string;
  limit?: string;
}

interface ProblemParams {
  slug: string;
}

interface SubmissionsQuery {
  limit?: string;
}

interface CreateProblemBody {
  title?: string;
  slug?: string;
  description?: string;
  examples?: string;
  constraints?: string;
  difficulty?: string;
  timeLimitMs?: number;
  memoryLimitMb?: number;
  starterCodePython?: string;
  starterCodeJavascript?: string;
  solutionPython?: string;
  solutionJavascript?: string;
  testCases?: Array<{
    input: string;
    expectedOutput: string;
    isSample?: boolean;
  }>;
}

// List all problems
router.get('/', async (req: Request<unknown, unknown, unknown, ListQuery>, res: Response): Promise<void> => {
  try {
    const { difficulty, search, page = '1', limit = '20' } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);

    let query = `
      SELECT p.id, p.title, p.slug, p.difficulty, p.created_at
      FROM problems p
      WHERE 1=1
    `;
    const params: (string | number)[] = [];

    if (difficulty && ['easy', 'medium', 'hard'].includes(difficulty)) {
      params.push(difficulty);
      query += ` AND p.difficulty = $${params.length}`;
    }

    if (search) {
      params.push(`%${search}%`);
      query += ` AND (p.title ILIKE $${params.length} OR p.slug ILIKE $${params.length})`;
    }

    // Get total count
    const countQuery = query.replace('SELECT p.id, p.title, p.slug, p.difficulty, p.created_at', 'SELECT COUNT(*)');
    const countResult = await pool.query(countQuery, params);
    const total = parseInt(countResult.rows[0].count);

    // Add pagination
    query += ` ORDER BY p.created_at ASC`;
    params.push(parseInt(limit));
    query += ` LIMIT $${params.length}`;
    params.push(offset);
    query += ` OFFSET $${params.length}`;

    const result = await pool.query(query, params);

    // If user is logged in, add their status for each problem
    let problems = result.rows;
    if (req.session.userId) {
      const statusResult = await pool.query(
        `SELECT problem_id, status FROM user_problem_status WHERE user_id = $1`,
        [req.session.userId]
      );
      const statusMap = new Map(statusResult.rows.map(r => [r.problem_id, r.status]));
      problems = problems.map(p => ({
        ...p,
        userStatus: statusMap.get(p.id) || 'unsolved'
      }));
    }

    res.json({
      problems,
      pagination: {
        total,
        page: parseInt(page),
        limit: parseInt(limit),
        pages: Math.ceil(total / parseInt(limit))
      }
    });
  } catch (error) {
    console.error('List problems error:', error);
    res.status(500).json({ error: 'Failed to fetch problems' });
  }
});

// Get problem by slug
router.get('/:slug', async (req: Request<ProblemParams>, res: Response): Promise<void> => {
  try {
    const { slug } = req.params;

    // Try cache first
    const cached = await redis.get(`problem:${slug}`);
    if (cached) {
      const problem = JSON.parse(cached);
      // Add user status if logged in
      if (req.session.userId) {
        const statusResult = await pool.query(
          `SELECT status, best_runtime_ms, attempts FROM user_problem_status WHERE user_id = $1 AND problem_id = $2`,
          [req.session.userId, problem.id]
        );
        problem.userStatus = statusResult.rows[0] || { status: 'unsolved', attempts: 0 };
      }
      res.json(problem);
      return;
    }

    const result = await pool.query(
      `SELECT p.*,
        (SELECT COUNT(*) FROM submissions WHERE problem_id = p.id AND status = 'accepted') as accepted_count,
        (SELECT COUNT(*) FROM submissions WHERE problem_id = p.id) as total_submissions
       FROM problems p
       WHERE p.slug = $1`,
      [slug]
    );

    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Problem not found' });
      return;
    }

    const problem = result.rows[0];

    // Get sample test cases only
    const testCasesResult = await pool.query(
      `SELECT id, input, expected_output, order_index
       FROM test_cases
       WHERE problem_id = $1 AND is_sample = true
       ORDER BY order_index`,
      [problem.id]
    );

    problem.sampleTestCases = testCasesResult.rows;

    // Cache for 5 minutes
    await redis.setex(`problem:${slug}`, 300, JSON.stringify(problem));

    // Add user status if logged in
    if (req.session.userId) {
      const statusResult = await pool.query(
        `SELECT status, best_runtime_ms, attempts FROM user_problem_status WHERE user_id = $1 AND problem_id = $2`,
        [req.session.userId, problem.id]
      );
      problem.userStatus = statusResult.rows[0] || { status: 'unsolved', attempts: 0 };
    }

    res.json(problem);
  } catch (error) {
    console.error('Get problem error:', error);
    res.status(500).json({ error: 'Failed to fetch problem' });
  }
});

// Get user's submissions for a problem
router.get('/:slug/submissions', requireAuth, async (req: Request<ProblemParams, unknown, unknown, SubmissionsQuery>, res: Response): Promise<void> => {
  try {
    const { slug } = req.params;
    const { limit = '10' } = req.query;

    const result = await pool.query(
      `SELECT s.id, s.language, s.status, s.runtime_ms, s.memory_kb,
              s.test_cases_passed, s.test_cases_total, s.created_at
       FROM submissions s
       JOIN problems p ON s.problem_id = p.id
       WHERE p.slug = $1 AND s.user_id = $2
       ORDER BY s.created_at DESC
       LIMIT $3`,
      [slug, req.session.userId, parseInt(limit)]
    );

    res.json({ submissions: result.rows });
  } catch (error) {
    console.error('Get submissions error:', error);
    res.status(500).json({ error: 'Failed to fetch submissions' });
  }
});

// Admin: Create problem
router.post('/', requireAdmin, async (req: Request<unknown, unknown, CreateProblemBody>, res: Response): Promise<void> => {
  try {
    const {
      title,
      slug,
      description,
      examples,
      constraints,
      difficulty,
      timeLimitMs,
      memoryLimitMb,
      starterCodePython,
      starterCodeJavascript,
      solutionPython,
      solutionJavascript,
      testCases
    } = req.body;

    if (!title || !slug || !description || !difficulty) {
      res.status(400).json({ error: 'Missing required fields' });
      return;
    }

    const result = await pool.query(
      `INSERT INTO problems (title, slug, description, examples, constraints, difficulty,
        time_limit_ms, memory_limit_mb, starter_code_python, starter_code_javascript,
        solution_python, solution_javascript)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       RETURNING *`,
      [
        title, slug, description, examples, constraints, difficulty,
        timeLimitMs || 2000, memoryLimitMb || 256,
        starterCodePython, starterCodeJavascript, solutionPython, solutionJavascript
      ]
    );

    const problem = result.rows[0];

    // Add test cases
    if (testCases && testCases.length > 0) {
      for (let i = 0; i < testCases.length; i++) {
        const tc = testCases[i];
        await pool.query(
          `INSERT INTO test_cases (problem_id, input, expected_output, is_sample, order_index)
           VALUES ($1, $2, $3, $4, $5)`,
          [problem.id, tc.input, tc.expectedOutput, tc.isSample || false, i]
        );
      }
    }

    // Invalidate cache
    await redis.del(`problem:${slug}`);

    res.status(201).json(problem);
  } catch (error) {
    console.error('Create problem error:', error);
    if ((error as { code?: string }).code === '23505') {
      res.status(409).json({ error: 'Problem with this slug already exists' });
      return;
    }
    res.status(500).json({ error: 'Failed to create problem' });
  }
});

export default router;
