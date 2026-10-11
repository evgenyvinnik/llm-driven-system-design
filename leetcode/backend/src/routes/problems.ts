import { Router, type Request, type Response } from 'express';
import pool from '../db/pool.js';
import redis from '../db/redis.js';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import { CHECKER_MODES, type CheckerMode } from '../services/checker.js';

const router = Router();

/**
 * Cache key for a problem's public view. The version prefix changes whenever the cached shape
 * changes: v1 entries were built from SELECT p.* and contained the reference solutions, so they
 * must never be served again (they simply expire unread).
 */
const problemCacheKey = (slug: string): string => `problem:v2:${slug}`;
const PROBLEM_CACHE_TTL_SECONDS = 300;
const MAX_PAGE_SIZE = 500;

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
  checker?: string;
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
    const { difficulty, search } = req.query;
    const page = Math.max(1, parseInt(req.query.page ?? '1', 10) || 1);
    const limit = Math.min(MAX_PAGE_SIZE, Math.max(1, parseInt(req.query.limit ?? '20', 10) || 20));
    const offset = (page - 1) * limit;

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
    query += ` ORDER BY p.created_at ASC, p.id ASC`;
    params.push(limit);
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
      const statusMap = new Map(statusResult.rows.map((r: { problem_id: string; status: string }) => [r.problem_id, r.status]));
      problems = problems.map((p: { id: string; title: string; slug: string; difficulty: string; created_at: string }) => ({
        ...p,
        userStatus: statusMap.get(p.id) || 'unsolved'
      }));
    }

    res.json({
      problems,
      pagination: {
        total,
        page,
        limit,
        pages: Math.ceil(total / limit)
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
    const cached = await redis.get(problemCacheKey(slug));
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

    // Explicit columns: the reference solutions (solution_*) must never leave the server.
    const result = await pool.query(
      `SELECT p.id, p.title, p.slug, p.description, p.examples, p.constraints, p.difficulty,
        p.time_limit_ms, p.memory_limit_mb, p.starter_code_python, p.starter_code_javascript,
        p.starter_code_cpp, p.starter_code_java, p.created_at, p.updated_at,
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

    // Cache for 5 minutes; acceptance counts in the cached copy may lag by that much
    await redis.setex(problemCacheKey(slug), PROBLEM_CACHE_TTL_SECONDS, JSON.stringify(problem));

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
// @ts-expect-error - Express type inference issue with generic params
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
  const {
    title,
    slug,
    description,
    examples,
    constraints,
    difficulty,
    checker = 'exact',
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
  if (!CHECKER_MODES.includes(checker as CheckerMode)) {
    res.status(400).json({ error: `checker must be one of: ${CHECKER_MODES.join(', ')}` });
    return;
  }

  // The problem and its test cases commit together: a judge must never see a problem
  // whose test data is half written.
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query(
      `INSERT INTO problems (title, slug, description, examples, constraints, difficulty, checker,
        time_limit_ms, memory_limit_mb, starter_code_python, starter_code_javascript,
        solution_python, solution_javascript)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       RETURNING id, title, slug, difficulty, checker, time_limit_ms, memory_limit_mb, created_at`,
      [
        title, slug, description, examples, constraints, difficulty, checker,
        timeLimitMs || 2000, memoryLimitMb || 256,
        starterCodePython, starterCodeJavascript, solutionPython, solutionJavascript
      ]
    );

    const problem = result.rows[0];

    for (const [i, tc] of (testCases ?? []).entries()) {
      await client.query(
        `INSERT INTO test_cases (problem_id, input, expected_output, is_sample, order_index)
         VALUES ($1, $2, $3, $4, $5)`,
        [problem.id, tc.input, tc.expectedOutput, tc.isSample || false, i]
      );
    }
    await client.query('COMMIT');

    // Invalidate cache
    await redis.del(problemCacheKey(slug));

    res.status(201).json(problem);
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Create problem error:', error);
    if ((error as { code?: string }).code === '23505') {
      res.status(409).json({ error: 'Problem with this slug already exists' });
      return;
    }
    res.status(500).json({ error: 'Failed to create problem' });
  } finally {
    client.release();
  }
});

export default router;
