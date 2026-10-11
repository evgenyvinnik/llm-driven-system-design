import { Router, type Request, type Response } from 'express';
import pool from '../db/pool.js';
import codeExecutor, { SandboxUnavailableError, SUPPORTED_LANGUAGES } from '../services/codeExecutor.js';
import { compareOutput, type CheckerMode } from '../services/checker.js';
import { createSubmission } from '../services/submissionService.js';
import { requireAuth } from '../middleware/auth.js';

// Shared modules
import { createModuleLogger } from '../shared/logger.js';
import { submissionRateLimiter, codeRunRateLimiter } from '../shared/rateLimiter.js';
import { parseIdempotencyKey } from '../shared/idempotency.js';
import { cachePending, readCachedStatus } from '../shared/submissionStatus.js';

const logger = createModuleLogger('submissions');
const router = Router();

/** Largest accepted source file; express.json also caps the whole body at 1 MB. */
const MAX_CODE_BYTES = 64 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TERMINAL_STATUSES = new Set([
  'accepted', 'wrong_answer', 'time_limit_exceeded', 'memory_limit_exceeded',
  'output_limit_exceeded', 'runtime_error', 'compile_error', 'system_error'
]);

interface SubmitBody {
  problemSlug?: unknown;
  language?: unknown;
  code?: unknown;
}

interface RunBody extends SubmitBody {
  customInput?: unknown;
}

interface SubmissionParams {
  id: string;
}

interface TestCase {
  input: string;
  expected_output: string | null;
}

type ValidSubmission = { problemSlug: string; language: string; code: string };

/** Validates the fields shared by submit and run; returns an error message or the typed body. */
function validateSubmission(body: SubmitBody): { error: string } | ValidSubmission {
  const { problemSlug, language, code } = body;
  if (typeof problemSlug !== 'string' || typeof language !== 'string' || typeof code !== 'string' || !problemSlug || !code.trim()) {
    return { error: 'Problem slug, language, and code are required' };
  }
  if (!SUPPORTED_LANGUAGES.includes(language)) {
    return { error: `Unsupported language. Use: ${SUPPORTED_LANGUAGES.join(', ')}` };
  }
  if (Buffer.byteLength(code, 'utf8') > MAX_CODE_BYTES) {
    return { error: `Code must be at most ${MAX_CODE_BYTES / 1024} KB` };
  }
  return { problemSlug, language, code };
}

/** Owners see their submissions; admins see everyone's. Everyone else gets 404, not 403. */
function canView(req: Request, ownerId: string): boolean {
  return req.session.userId === ownerId || req.session.role === 'admin';
}

function sendSandboxUnavailable(res: Response, error: SandboxUnavailableError): void {
  const retryAfter = Math.ceil(error.retryAfterMs / 1000);
  res.set('Retry-After', String(retryAfter));
  res.status(503).json({
    error: 'Service temporarily unavailable',
    message: 'Code execution is temporarily unavailable. Please try again shortly.',
    retryAfter
  });
}

/**
 * Submit code for judging. Returns 202 as soon as the submission is committed to the judge
 * queue; clients poll GET /:id/status for the verdict.
 *
 * Send an Idempotency-Key header (a UUID per submit attempt) to make retries safe: repeating
 * the request returns the same submission, and reusing the key for different code returns 422.
 */
router.post('/', requireAuth, submissionRateLimiter, async (req: Request<unknown, unknown, SubmitBody>, res: Response): Promise<void> => {
  const userId = req.session.userId!;
  const parsedKey = parseIdempotencyKey(req.headers['idempotency-key']);
  if (!parsedKey.ok) {
    res.status(400).json({ error: parsedKey.error });
    return;
  }

  const body = validateSubmission(req.body);
  if ('error' in body) {
    res.status(400).json({ error: body.error });
    return;
  }

  try {
    const result = await createSubmission(pool, { userId, ...body, idempotencyKey: parsedKey.key });

    switch (result.kind) {
      case 'problem_not_found':
        res.status(404).json({ error: 'Problem not found' });
        return;
      case 'key_reused':
        res.status(422).json({ error: 'Idempotency-Key was already used with a different request body' });
        return;
      case 'replayed':
        res.set('Idempotent-Replayed', 'true');
        res.status(202).json({
          submissionId: result.submission.id,
          status: result.submission.status,
          message: 'Submission already received'
        });
        return;
      case 'duplicate':
        res.status(200).json({
          submissionId: result.submission.id,
          status: result.submission.status,
          duplicate: true,
          message: 'An identical submission is already being judged'
        });
        return;
      case 'created':
        await cachePending(result.submission.id, userId);
        logger.info({
          submissionId: result.submission.id,
          userId,
          problemSlug: body.problemSlug,
          language: body.language,
          hasIdempotencyKey: parsedKey.key !== null
        }, 'Submission queued');
        res.status(202).json({
          submissionId: result.submission.id,
          status: 'pending',
          message: 'Submission received, waiting for a judge...'
        });
        return;
    }
  } catch (error) {
    logger.error({
      error: (error as Error).message,
      userId,
      path: req.path
    }, 'Submit error');

    res.status(500).json({ error: 'Failed to submit code' });
  }
});

/**
 * Run code against the sample test cases (or custom input) without saving a submission.
 * Runs synchronously in the API process: the program is compiled once and each sample runs in
 * a fresh container. Judging of real submissions goes through the queue instead.
 */
router.post('/run', requireAuth, codeRunRateLimiter, async (req: Request<unknown, unknown, RunBody>, res: Response): Promise<void> => {
  const body = validateSubmission(req.body);
  if ('error' in body) {
    res.status(400).json({ error: body.error });
    return;
  }
  const { customInput } = req.body;
  if (customInput !== undefined && customInput !== null && typeof customInput !== 'string') {
    res.status(400).json({ error: 'customInput must be a string' });
    return;
  }

  try {
    const problemResult = await pool.query<{ id: string; time_limit_ms: number; memory_limit_mb: number; checker: CheckerMode }>(
      'SELECT id, time_limit_ms, memory_limit_mb, checker FROM problems WHERE slug = $1',
      [body.problemSlug]
    );

    if (problemResult.rows.length === 0) {
      res.status(404).json({ error: 'Problem not found' });
      return;
    }

    const problem = problemResult.rows[0];

    let testCases: TestCase[];
    if (typeof customInput === 'string') {
      testCases = [{ input: customInput, expected_output: null }];
    } else {
      const testCasesResult = await pool.query<TestCase>(
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
      problemSlug: body.problemSlug,
      language: body.language,
      testCaseCount: testCases.length
    }, 'Running code against sample test cases');

    const program = await codeExecutor.prepare(body.code, body.language);
    try {
      if (program.compileError !== undefined) {
        res.json({
          results: [{
            input: testCases[0].input,
            expectedOutput: testCases[0].expected_output,
            actualOutput: null,
            status: 'compile_error',
            passed: null,
            executionTime: 0,
            error: program.compileError
          }]
        });
        return;
      }

      const results = [];
      for (const tc of testCases) {
        const result = await codeExecutor.run(program, tc.input, {
          timeLimitMs: problem.time_limit_ms,
          memoryLimitMb: problem.memory_limit_mb
        });

        // null means "not compared": custom input, or a run that ended in TLE/MLE/RE/OLE
        // (the client shows that status instead of a pass/fail badge).
        const passed = tc.expected_output !== null && result.status === 'success'
          ? compareOutput(result.stdout, tc.expected_output, problem.checker)
          : null;

        results.push({
          input: tc.input,
          expectedOutput: tc.expected_output,
          actualOutput: result.stdout || null,
          status: result.status,
          passed,
          executionTime: result.executionTime,
          error: result.stderr || null
        });
      }

      res.json({ results });
    } finally {
      await codeExecutor.dispose(program);
    }
  } catch (error) {
    if (error instanceof SandboxUnavailableError) {
      sendSandboxUnavailable(res, error);
      return;
    }
    logger.error({
      error: (error as Error).message,
      userId: req.session.userId,
      path: req.path
    }, 'Run error');

    res.status(500).json({ error: 'Failed to run code' });
  }
});

// Get submission details (owner or admin only)
router.get('/:id', requireAuth, async (req: Request<SubmissionParams>, res: Response): Promise<void> => {
  const { id } = req.params;
  if (!UUID.test(id)) {
    res.status(404).json({ error: 'Submission not found' });
    return;
  }

  try {
    const result = await pool.query(
      `SELECT s.id, s.user_id, s.problem_id, s.language, s.code, s.status, s.runtime_ms, s.memory_kb,
              s.test_cases_passed, s.test_cases_total, s.error_message, s.created_at, s.judged_at,
              p.slug as problem_slug, p.title as problem_title
       FROM submissions s
       JOIN problems p ON s.problem_id = p.id
       WHERE s.id = $1`,
      [id]
    );

    if (result.rows.length === 0 || !canView(req, result.rows[0].user_id)) {
      res.status(404).json({ error: 'Submission not found' });
      return;
    }

    res.json(result.rows[0]);
  } catch (error) {
    logger.error({
      error: (error as Error).message,
      submissionId: id
    }, 'Get submission error');

    res.status(500).json({ error: 'Failed to fetch submission' });
  }
});

/**
 * Poll submission status. Reads the Redis status cache first (written by the judge worker after
 * each test case) and falls back to PostgreSQL, the source of truth, on a miss.
 */
router.get('/:id/status', requireAuth, async (req: Request<SubmissionParams>, res: Response): Promise<void> => {
  const { id } = req.params;
  if (!UUID.test(id)) {
    res.status(404).json({ error: 'Submission not found' });
    return;
  }

  try {
    const cached = await readCachedStatus(id);
    if (cached) {
      if (!canView(req, cached.user_id)) {
        res.status(404).json({ error: 'Submission not found' });
        return;
      }
      const { user_id: _userId, terminal, ...status } = cached;
      if (!terminal) res.set('Retry-After', '1');
      res.json(status);
      return;
    }

    const result = await pool.query(
      `SELECT user_id, status, runtime_ms, memory_kb, test_cases_passed, test_cases_total, error_message
       FROM submissions WHERE id = $1`,
      [id]
    );

    if (result.rows.length === 0 || !canView(req, result.rows[0].user_id)) {
      res.status(404).json({ error: 'Submission not found' });
      return;
    }

    const { user_id: _userId, ...status } = result.rows[0];
    if (!TERMINAL_STATUSES.has(status.status)) {
      // Still queued or running: tell well-behaved clients how soon to ask again.
      res.set('Retry-After', '1');
    }
    res.json(status);
  } catch (error) {
    logger.error({
      error: (error as Error).message,
      submissionId: id
    }, 'Get submission status error');

    res.status(500).json({ error: 'Failed to fetch submission status' });
  }
});

export default router;
