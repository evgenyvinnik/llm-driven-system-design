import { Router, type Request, type Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import pool from '../db/pool.js';
import redis from '../db/redis.js';
import codeExecutor from '../services/codeExecutor.js';
import { requireAuth } from '../middleware/auth.js';

// Shared modules
import { createModuleLogger } from '../shared/logger.js';
import { metrics } from '../shared/metrics.js';
import { submissionRateLimiter, codeRunRateLimiter } from '../shared/rateLimiter.js';
import { submissionIdempotency } from '../shared/idempotency.js';
import { publishSubmissionJob, type SubmissionJob } from '../shared/kafka.js';

const logger = createModuleLogger('submissions');
const router = Router();

// Supported languages
const SUPPORTED_LANGUAGES = ['python', 'javascript', 'cpp', 'java'];

// Use Kafka queue if enabled (default: false for backward compatibility)
const USE_KAFKA_QUEUE = process.env.USE_KAFKA_QUEUE === 'true';

// Initialize code executor (only needed if not using Kafka queue)
if (!USE_KAFKA_QUEUE) {
  codeExecutor.init();
}

interface SubmitBody {
  problemSlug?: string;
  language?: string;
  code?: string;
}

interface RunBody {
  problemSlug?: string;
  language?: string;
  code?: string;
  customInput?: string | null;
}

interface SubmissionParams {
  id: string;
}

interface Problem {
  id: string;
  time_limit_ms: number;
  memory_limit_mb: number;
  difficulty: string;
}

interface TestCase {
  input: string;
  expected_output: string | null;
}

// Submit code with rate limiting and idempotency
router.post('/', requireAuth, submissionRateLimiter, submissionIdempotency(), async (req: Request<unknown, unknown, SubmitBody>, res: Response): Promise<void> => {
  const startTime = Date.now();

  try {
    const { problemSlug, language, code } = req.body;

    if (!problemSlug || !language || !code) {
      res.status(400).json({ error: 'Problem slug, language, and code are required' });
      return;
    }

    if (!SUPPORTED_LANGUAGES.includes(language)) {
      res.status(400).json({ error: `Unsupported language. Use: ${SUPPORTED_LANGUAGES.join(', ')}` });
      return;
    }

    // Get problem
    const problemResult = await pool.query(
      'SELECT id, time_limit_ms, memory_limit_mb, difficulty FROM problems WHERE slug = $1',
      [problemSlug]
    );

    if (problemResult.rows.length === 0) {
      res.status(404).json({ error: 'Problem not found' });
      return;
    }

    const problem: Problem = problemResult.rows[0];

    // Create submission record
    const submissionId = uuidv4();
    await pool.query(
      `INSERT INTO submissions (id, user_id, problem_id, language, code, status)
       VALUES ($1, $2, $3, $4, $5, 'pending')`,
      [submissionId, req.session.userId, problem.id, language, code]
    );

    // Store idempotency key for this submission
    if (req.storeIdempotencyKey) {
      await req.storeIdempotencyKey(submissionId);
    }

    // Update attempt count
    await pool.query(
      `INSERT INTO user_problem_status (user_id, problem_id, status, attempts)
       VALUES ($1, $2, 'attempted', 1)
       ON CONFLICT (user_id, problem_id) DO UPDATE SET
         attempts = user_problem_status.attempts + 1,
         status = CASE WHEN user_problem_status.status = 'solved' THEN 'solved' ELSE 'attempted' END`,
      [req.session.userId, problem.id]
    );

    // Increment submissions in progress metric
    metrics.submissionsInProgress.inc();

    logger.info({
      submissionId,
      userId: req.session.userId,
      problemSlug,
      language,
      difficulty: problem.difficulty,
      useKafka: USE_KAFKA_QUEUE,
    }, 'Submission created');

    if (USE_KAFKA_QUEUE) {
      // Get test cases for Kafka job
      const testCasesResult = await pool.query(
        `SELECT id, input, expected_output, is_sample FROM test_cases
         WHERE problem_id = $1
         ORDER BY order_index`,
        [problem.id]
      );

      // Publish to Kafka queue
      const job: SubmissionJob = {
        submissionId,
        userId: req.session.userId!,
        problemId: problem.id,
        code,
        language,
        testCases: testCasesResult.rows.map(tc => ({
          id: tc.id,
          input: tc.input,
          expectedOutput: tc.expected_output,
          isSample: tc.is_sample,
        })),
        timeLimit: problem.time_limit_ms,
        memoryLimit: problem.memory_limit_mb,
        createdAt: new Date().toISOString(),
      };

      await publishSubmissionJob(job);
    } else {
      // Process submission asynchronously (legacy mode)
      processSubmission(submissionId, problem, language, code, req.session.userId!, startTime);
    }

    res.status(202).json({
      submissionId,
      status: 'pending',
      message: 'Submission received, processing...'
    });
  } catch (error) {
    logger.error({
      error: (error as Error).message,
      userId: req.session.userId,
      path: req.path
    }, 'Submit error');

    res.status(500).json({ error: 'Failed to submit code' });
  }
});

// Run code against sample test cases (without saving submission)
router.post('/run', requireAuth, codeRunRateLimiter, async (req: Request<unknown, unknown, RunBody>, res: Response): Promise<void> => {
  try {
    const { problemSlug, language, code, customInput } = req.body;

    if (!problemSlug || !language || !code) {
      res.status(400).json({ error: 'Problem slug, language, and code are required' });
      return;
    }

    if (!SUPPORTED_LANGUAGES.includes(language)) {
      res.status(400).json({ error: `Unsupported language. Use: ${SUPPORTED_LANGUAGES.join(', ')}` });
      return;
    }

    // Get problem
    const problemResult = await pool.query(
      'SELECT id, time_limit_ms, memory_limit_mb FROM problems WHERE slug = $1',
      [problemSlug]
    );

    if (problemResult.rows.length === 0) {
      res.status(404).json({ error: 'Problem not found' });
      return;
    }

    const problem = problemResult.rows[0];

    let testCases: TestCase[];
    if (customInput !== undefined && customInput !== null) {
      // Use custom input
      testCases = [{ input: customInput, expected_output: null }];
    } else {
      // Get sample test cases
      const testCasesResult = await pool.query(
        `SELECT input, expected_output FROM test_cases
         WHERE problem_id = $1 AND is_sample = true
         ORDER BY order_index`,
        [problem.id]
      );
      testCases = testCasesResult.rows;
    }

    if (testCases.length === 0) {
      res.status(400).json({ error: 'No test cases available' });
      return;
    }

    logger.info({
      userId: req.session.userId,
      problemSlug,
      language,
      testCaseCount: testCases.length
    }, 'Running code against sample test cases');

    // Run against test cases
    const results = [];
    for (const tc of testCases) {
      const result = await codeExecutor.execute(
        code,
        language,
        tc.input,
        problem.time_limit_ms,
        problem.memory_limit_mb
      );

      // Check if circuit breaker rejected the request
      if (result.isCircuitBreakerOpen) {
        res.status(503).json({
          error: 'Service temporarily unavailable',
          message: result.error,
          retryAfter: 30
        });
        return;
      }

      let passed = null;
      if (tc.expected_output && result.status === 'success') {
        passed = codeExecutor.compareOutput(result.stdout || '', tc.expected_output);
      }

      results.push({
        input: tc.input,
        expectedOutput: tc.expected_output,
        actualOutput: result.stdout || null,
        status: result.status,
        passed,
        executionTime: result.executionTime,
        error: result.stderr || result.error || null
      });
    }

    res.json({ results });
  } catch (error) {
    logger.error({
      error: (error as Error).message,
      userId: req.session.userId,
      path: req.path
    }, 'Run error');

    res.status(500).json({ error: 'Failed to run code' });
  }
});

// Get submission status
router.get('/:id', async (req: Request<SubmissionParams>, res: Response): Promise<void> => {
  try {
    const { id } = req.params;

    const result = await pool.query(
      `SELECT s.*, p.slug as problem_slug, p.title as problem_title
       FROM submissions s
       JOIN problems p ON s.problem_id = p.id
       WHERE s.id = $1`,
      [id]
    );

    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Submission not found' });
      return;
    }

    const submission = result.rows[0];

    // Only show code to the owner
    if (req.session.userId !== submission.user_id) {
      delete submission.code;
    }

    res.json(submission);
  } catch (error) {
    logger.error({
      error: (error as Error).message,
      submissionId: req.params.id
    }, 'Get submission error');

    res.status(500).json({ error: 'Failed to fetch submission' });
  }
});

// Poll submission status (for real-time updates)
router.get('/:id/status', async (req: Request<SubmissionParams>, res: Response): Promise<void> => {
  try {
    const { id } = req.params;

    // Check Redis cache first for faster polling
    const cached = await redis.get(`submission:${id}:status`);
    if (cached) {
      metrics.cacheHits.inc({ cache_type: 'submission_status' });
      res.json(JSON.parse(cached));
      return;
    }

    metrics.cacheMisses.inc({ cache_type: 'submission_status' });

    const result = await pool.query(
      `SELECT status, runtime_ms, memory_kb, test_cases_passed, test_cases_total, error_message
       FROM submissions WHERE id = $1`,
      [id]
    );

    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Submission not found' });
      return;
    }

    res.json(result.rows[0]);
  } catch (error) {
    logger.error({
      error: (error as Error).message,
      submissionId: req.params.id
    }, 'Get submission status error');

    res.status(500).json({ error: 'Failed to fetch submission status' });
  }
});

// Process submission in background
async function processSubmission(submissionId: string, problem: Problem, language: string, code: string, userId: string, startTime: number): Promise<void> {
  try {
    // Update status to running
    await pool.query(
      `UPDATE submissions SET status = 'running' WHERE id = $1`,
      [submissionId]
    );

    // Cache status for polling
    await redis.setex(`submission:${submissionId}:status`, 60, JSON.stringify({
      status: 'running',
      test_cases_passed: 0,
      test_cases_total: 0
    }));

    // Get all test cases
    const testCasesResult = await pool.query(
      `SELECT input, expected_output FROM test_cases
       WHERE problem_id = $1
       ORDER BY order_index`,
      [problem.id]
    );

    const testCases: { input: string; expected_output: string }[] = testCasesResult.rows;
    let passed = 0;
    let totalTime = 0;
    const maxMemory = 0;
    let finalStatus = 'accepted';
    let errorMessage: string | null = null;

    for (let i = 0; i < testCases.length; i++) {
      const tc = testCases[i];

      const result = await codeExecutor.execute(
        code,
        language,
        tc.input,
        problem.time_limit_ms,
        problem.memory_limit_mb
      );

      totalTime += result.executionTime || 0;

      // Update progress in cache
      await redis.setex(`submission:${submissionId}:status`, 60, JSON.stringify({
        status: 'running',
        test_cases_passed: passed,
        test_cases_total: testCases.length,
        current_test: i + 1
      }));

      // Check if circuit breaker is open
      if (result.isCircuitBreakerOpen) {
        finalStatus = 'system_error';
        errorMessage = 'Code execution service temporarily unavailable. Please retry.';
        break;
      }

      if (result.status !== 'success') {
        finalStatus = result.status;
        errorMessage = result.stderr || result.error || null;
        break;
      }

      const isCorrect = codeExecutor.compareOutput(result.stdout || '', tc.expected_output);
      if (!isCorrect) {
        finalStatus = 'wrong_answer';
        errorMessage = `Test case ${i + 1} failed. Expected: ${tc.expected_output.substring(0, 100)}, Got: ${(result.stdout || '').substring(0, 100)}`;
        break;
      }

      passed++;
    }

    const avgTime = testCases.length > 0 ? Math.round(totalTime / testCases.length) : 0;
    const totalDuration = (Date.now() - startTime) / 1000;

    // Update submission record
    await pool.query(
      `UPDATE submissions SET
        status = $2,
        runtime_ms = $3,
        memory_kb = $4,
        test_cases_passed = $5,
        test_cases_total = $6,
        error_message = $7
       WHERE id = $1`,
      [submissionId, finalStatus, avgTime, maxMemory, passed, testCases.length, errorMessage]
    );

    // Record metrics
    metrics.submissionsTotal.inc({
      status: finalStatus,
      language,
      difficulty: problem.difficulty
    });

    metrics.submissionDuration.observe(
      { language, status: finalStatus },
      totalDuration
    );

    // Decrement in-progress counter
    metrics.submissionsInProgress.dec();

    logger.info({
      submissionId,
      userId,
      problemId: problem.id,
      status: finalStatus,
      testCasesPassed: passed,
      testCasesTotal: testCases.length,
      durationMs: Date.now() - startTime
    }, 'Submission processed');

    // Update user problem status if accepted
    if (finalStatus === 'accepted') {
      await pool.query(
        `UPDATE user_problem_status SET
          status = 'solved',
          best_runtime_ms = LEAST(COALESCE(best_runtime_ms, $3), $3),
          solved_at = COALESCE(solved_at, NOW())
         WHERE user_id = $1 AND problem_id = $2`,
        [userId, problem.id, avgTime]
      );
    }

    // Update cache with final status
    await redis.setex(`submission:${submissionId}:status`, 300, JSON.stringify({
      status: finalStatus,
      runtime_ms: avgTime,
      memory_kb: maxMemory,
      test_cases_passed: passed,
      test_cases_total: testCases.length,
      error_message: errorMessage
    }));

    // Invalidate problem cache (to update acceptance rate)
    const problemSlugResult = await pool.query('SELECT slug FROM problems WHERE id = $1', [problem.id]);
    if (problemSlugResult.rows.length > 0) {
      await redis.del(`problem:${problemSlugResult.rows[0].slug}`);
    }

  } catch (error) {
    logger.error({
      error: (error as Error).message,
      submissionId,
      userId
    }, 'Process submission error');

    // Decrement in-progress counter
    metrics.submissionsInProgress.dec();

    // Record error metric
    metrics.submissionsTotal.inc({
      status: 'system_error',
      language,
      difficulty: problem.difficulty
    });

    // Update submission with error
    await pool.query(
      `UPDATE submissions SET status = 'system_error', error_message = $2 WHERE id = $1`,
      [submissionId, (error as Error).message]
    );

    await redis.setex(`submission:${submissionId}:status`, 300, JSON.stringify({
      status: 'system_error',
      error_message: (error as Error).message
    }));
  }
}

export default router;
