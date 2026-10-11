import pg from 'pg';
import type { Pool } from 'pg';
import { dbConfig } from '../db/pool.js';
import { createModuleLogger } from '../shared/logger.js';
import { metrics } from '../shared/metrics.js';
import * as judgeQueue from '../shared/judgeQueue.js';
import type { ClaimedJob } from '../shared/judgeQueue.js';
import { cacheProgress, cacheVerdict } from '../shared/submissionStatus.js';
import { judgeSubmission, JudgeAbortedError, type JudgeProblem, type Sandbox, type Verdict } from '../services/judge.js';
import { SandboxUnavailableError } from '../services/codeExecutor.js';
import type { CheckerMode } from '../services/checker.js';

const logger = createModuleLogger('judge-worker');

/** How long a worker keeps a problem's limits and test cases in memory. */
const PROBLEM_CACHE_TTL_MS = 60000;
/** Delay before re-opening the LISTEN connection after it drops. */
const LISTEN_RETRY_MS = 5000;

export interface JudgeWorkerOptions {
  workerId: string;
  /** Submissions judged at the same time by this worker. */
  concurrency: number;
  /** Lease length; heartbeats extend it every leaseMs / 3. */
  leaseMs: number;
  /** Fallback poll interval when no NOTIFY arrives (retries, expired leases, lost notifications). */
  pollIntervalMs: number;
  /** Claims allowed before a job is given up as system_error. */
  maxAttempts: number;
  /** Languages this worker judges; null means all. */
  languages: string[] | null;
}

type QueueOps = Pick<typeof judgeQueue, 'claimJobs' | 'extendLease' | 'completeJob' | 'retryJob' | 'releaseJob' | 'countPending'>;

interface CachedProblem extends JudgeProblem {
  difficulty: string;
}

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = parseInt(value ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** Reads JUDGE_* and WORKER_LANGUAGES environment variables. */
export function judgeWorkerOptionsFromEnv(workerId: string): JudgeWorkerOptions {
  const languages = (process.env.WORKER_LANGUAGES ?? '')
    .split(',')
    .map((language) => language.trim())
    .filter(Boolean);
  return {
    workerId,
    concurrency: positiveInt(process.env.JUDGE_CONCURRENCY, 2),
    leaseMs: positiveInt(process.env.JUDGE_LEASE_MS, 30000),
    pollIntervalMs: positiveInt(process.env.JUDGE_POLL_MS, 2000),
    maxAttempts: positiveInt(process.env.JUDGE_MAX_ATTEMPTS, 3),
    languages: languages.length > 0 ? languages : null
  };
}

/** Exponential backoff with jitter; never sooner than the sandbox asked for (an open breaker says 30 s). */
export function retryDelayMs(attempt: number, error: Error): number {
  const base = Math.min(60000, 5000 * 2 ** Math.max(0, attempt - 1));
  const floor = error instanceof SandboxUnavailableError ? error.retryAfterMs : 0;
  const jitter = 0.8 + Math.random() * 0.4;
  return Math.max(floor, Math.round(base * jitter));
}

/**
 * Pulls submissions from the judge queue (the submissions table) and judges them.
 *
 * Runs inside the API process for local development (EMBEDDED_WORKER, the default) or as a
 * separate process (npm run dev:worker1). Any number of workers can share the queue: claims use
 * SKIP LOCKED, and the lease token fences every write.
 */
export class JudgeWorker {
  private running = false;
  private loopDone: Promise<void> = Promise.resolve();
  private readonly inFlight = new Map<string, Promise<void>>();
  private readonly problemCache = new Map<string, { expiresAt: number; problem: CachedProblem }>();
  private wakeRequested = false;
  private wakeResolve: (() => void) | null = null;
  private listener: pg.Client | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private lastDepthSample = 0;

  constructor(
    private readonly pool: Pool,
    private readonly sandbox: Sandbox,
    private readonly options: JudgeWorkerOptions,
    private readonly queue: QueueOps = judgeQueue,
    private readonly listen = true
  ) {}

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    if (this.listen) {
      await this.connectListener();
    }
    this.loopDone = this.loop();
    logger.info({ ...this.options }, 'Judge worker started');
  }

  /**
   * Stops claiming, lets in-flight jobs reach a test boundary and hand themselves back to the
   * queue, then closes the LISTEN connection. Jobs still running after `timeoutMs` keep their
   * lease, which expires so another worker can take them.
   */
  async stop(timeoutMs = 15000): Promise<void> {
    if (!this.running) return;
    this.running = false;
    this.wake();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    await this.loopDone;

    let timer: NodeJS.Timeout | undefined;
    const drained = await Promise.race([
      Promise.allSettled([...this.inFlight.values()]).then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      })
    ]);
    clearTimeout(timer);
    if (!drained) {
      logger.warn({ inFlight: this.inFlight.size }, 'Stopped before in-flight jobs finished; their leases will expire');
    }

    const listener = this.listener;
    this.listener = null;
    await listener?.end().catch(() => {});
    logger.info({ workerId: this.options.workerId }, 'Judge worker stopped');
  }

  /** Number of jobs this worker is judging right now. */
  get activeJobs(): number {
    return this.inFlight.size;
  }

  private async loop(): Promise<void> {
    while (this.running) {
      const free = this.options.concurrency - this.inFlight.size;
      if (free > 0) {
        let jobs: ClaimedJob[] = [];
        try {
          jobs = await this.queue.claimJobs(this.pool, {
            workerId: this.options.workerId,
            limit: free,
            leaseMs: this.options.leaseMs,
            languages: this.options.languages
          });
        } catch (error) {
          logger.warn({ error: (error as Error).message }, 'Failed to claim jobs; will retry');
        }
        for (const job of jobs) this.track(job);
        // Every free slot was filled: there may be more work, so look again right away.
        if (jobs.length > 0 && jobs.length === free) continue;
      }
      await this.sampleQueueDepth();
      await this.sleep(this.options.pollIntervalMs);
    }
  }

  private track(job: ClaimedJob): void {
    const done = this.process(job)
      .catch((error: Error) => {
        logger.error({ error: error.message, submissionId: job.submissionId }, 'Unhandled error while judging');
      })
      .finally(() => {
        this.inFlight.delete(job.submissionId);
        this.wake();
      });
    this.inFlight.set(job.submissionId, done);
  }

  private async process(job: ClaimedJob): Promise<void> {
    metrics.submissionsInProgress.inc();
    metrics.judgeQueueWait.observe(job.waitSeconds);

    // A job that keeps coming back (for example because judging it crashed the worker) stops here.
    if (job.judgeAttempts > this.options.maxAttempts) {
      try {
        await this.deadLetter(job, 'unknown', `Judging failed after ${job.judgeAttempts - 1} attempts; please resubmit`);
      } finally {
        metrics.submissionsInProgress.dec();
      }
      return;
    }

    let leaseLost = false;
    const heartbeat = setInterval(() => {
      this.queue.extendLease(this.pool, job, this.options.leaseMs)
        .then((owned) => {
          if (!owned) leaseLost = true;
        })
        .catch((error: Error) => {
          logger.warn({ error: error.message, submissionId: job.submissionId }, 'Lease heartbeat failed');
        });
    }, Math.max(1000, Math.floor(this.options.leaseMs / 3)));

    let difficulty = 'unknown';
    try {
      const problem = await this.loadProblem(job.problemId);
      difficulty = problem.difficulty;
      const verdict = await judgeSubmission(job, problem, this.sandbox, {
        onProgress: (progress) => cacheProgress(job.submissionId, {
          user_id: job.userId,
          status: 'running',
          current_test: progress.currentTest,
          test_cases_passed: progress.testCasesPassed,
          test_cases_total: progress.testCasesTotal
        }),
        shouldContinue: () => this.running && !leaseLost
      });
      await this.finish(job, verdict, difficulty, 'completed');
    } catch (error) {
      if (error instanceof JudgeAbortedError) {
        if (leaseLost) {
          metrics.judgeJobsTotal.inc({ outcome: 'lease_lost' });
          logger.warn({ submissionId: job.submissionId }, 'Lease lost while judging; another worker owns the job');
        } else {
          await this.queue.releaseJob(this.pool, job).catch(() => false);
          metrics.judgeJobsTotal.inc({ outcome: 'released' });
          logger.info({ submissionId: job.submissionId }, 'Released job back to the queue during shutdown');
        }
        return;
      }
      await this.handleFailure(job, error as Error, difficulty);
    } finally {
      clearInterval(heartbeat);
      metrics.submissionsInProgress.dec();
    }
  }

  /** Commits the verdict (fenced by the lease token) and then publishes it to the status cache. */
  private async finish(job: ClaimedJob, verdict: Verdict, difficulty: string, outcome: 'completed' | 'dead_lettered'): Promise<void> {
    const committed = await this.queue.completeJob(this.pool, job, verdict);
    if (!committed) {
      metrics.judgeJobsTotal.inc({ outcome: 'lease_lost' });
      logger.warn({ submissionId: job.submissionId }, 'Verdict discarded: the lease was taken over by another worker');
      return;
    }

    metrics.judgeJobsTotal.inc({ outcome });
    metrics.submissionsTotal.inc({ status: verdict.status, language: job.language, difficulty });
    await cacheVerdict(job.submissionId, {
      user_id: job.userId,
      status: verdict.status,
      test_cases_passed: verdict.testCasesPassed,
      test_cases_total: verdict.testCasesTotal,
      runtime_ms: verdict.runtimeMs,
      memory_kb: verdict.memoryKb,
      error_message: verdict.errorMessage
    });
    logger.info({
      submissionId: job.submissionId,
      status: verdict.status,
      testCasesPassed: verdict.testCasesPassed,
      testCasesTotal: verdict.testCasesTotal,
      attempt: job.judgeAttempts
    }, 'Submission judged');
  }

  /** Sandbox or database failure: retry with backoff, or give up after maxAttempts. */
  private async handleFailure(job: ClaimedJob, error: Error, difficulty: string): Promise<void> {
    logger.warn({ error: error.message, submissionId: job.submissionId, attempt: job.judgeAttempts }, 'Judging failed');

    if (job.judgeAttempts >= this.options.maxAttempts) {
      await this.deadLetter(job, difficulty, `Judging failed after ${job.judgeAttempts} attempts; please resubmit`);
      return;
    }

    const delayMs = retryDelayMs(job.judgeAttempts, error);
    const message = `The judge is temporarily unavailable; retrying automatically (attempt ${job.judgeAttempts} of ${this.options.maxAttempts})`;
    const requeued = await this.queue.retryJob(this.pool, job, delayMs, message);
    if (!requeued) {
      metrics.judgeJobsTotal.inc({ outcome: 'lease_lost' });
      return;
    }
    metrics.judgeJobsTotal.inc({ outcome: 'retried' });
    await cacheProgress(job.submissionId, { user_id: job.userId, status: 'pending', error_message: message });
  }

  /** The dead-letter outcome: a final system_error the user can see, instead of endless retries. */
  private async deadLetter(job: ClaimedJob, difficulty: string, message: string): Promise<void> {
    const verdict: Verdict = {
      status: 'system_error',
      testCasesPassed: 0,
      testCasesTotal: 0,
      runtimeMs: null,
      memoryKb: null,
      errorMessage: message
    };
    await this.finish(job, verdict, difficulty, 'dead_lettered');
  }

  private async loadProblem(problemId: string): Promise<CachedProblem> {
    const cached = this.problemCache.get(problemId);
    if (cached && cached.expiresAt > Date.now()) return cached.problem;

    const problemResult = await this.pool.query<{ time_limit_ms: number; memory_limit_mb: number; checker: CheckerMode; difficulty: string }>(
      'SELECT time_limit_ms, memory_limit_mb, checker, difficulty FROM problems WHERE id = $1',
      [problemId]
    );
    if (problemResult.rows.length === 0) {
      throw new Error(`Problem ${problemId} not found`);
    }
    const testCases = await this.pool.query<{ input: string; expected_output: string }>(
      'SELECT input, expected_output FROM test_cases WHERE problem_id = $1 ORDER BY order_index',
      [problemId]
    );

    const row = problemResult.rows[0];
    const problem: CachedProblem = {
      timeLimitMs: row.time_limit_ms,
      memoryLimitMb: row.memory_limit_mb,
      checker: row.checker,
      difficulty: row.difficulty,
      testCases: testCases.rows.map((tc) => ({ input: tc.input, expectedOutput: tc.expected_output }))
    };
    this.problemCache.set(problemId, { expiresAt: Date.now() + PROBLEM_CACHE_TTL_MS, problem });
    return problem;
  }

  private async sampleQueueDepth(): Promise<void> {
    if (Date.now() - this.lastDepthSample < this.options.pollIntervalMs) return;
    this.lastDepthSample = Date.now();
    try {
      metrics.judgeQueueDepth.set(await this.queue.countPending(this.pool));
    } catch {
      // The gauge is best effort; the claim loop already logs database failures.
    }
  }

  private sleep(ms: number): Promise<void> {
    if (this.wakeRequested || !this.running) {
      this.wakeRequested = false;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => done(), ms);
      const done = (): void => {
        clearTimeout(timer);
        this.wakeResolve = null;
        resolve();
      };
      this.wakeResolve = done;
    });
  }

  /** Ends the current sleep early: a NOTIFY arrived, a slot freed up, or stop() was called. */
  private wake(): void {
    if (this.wakeResolve) {
      this.wakeResolve();
    } else {
      this.wakeRequested = true;
    }
  }

  /**
   * Holds a dedicated connection that LISTENs on the queue channel, so new submissions start
   * within milliseconds instead of waiting for the next poll. If the connection drops it is
   * re-opened; polling keeps the worker correct in the meantime.
   */
  private async connectListener(): Promise<void> {
    const client = new pg.Client(dbConfig);
    const onLost = (error?: Error): void => {
      if (this.listener !== client) return;
      this.listener = null;
      logger.warn({ error: error?.message }, 'LISTEN connection lost; polling until it reconnects');
      client.end().catch(() => {});
      this.scheduleListenerReconnect();
    };
    client.on('notification', () => this.wake());
    client.on('error', (error: Error) => onLost(error));
    client.on('end', () => onLost());

    try {
      await client.connect();
      await client.query(`LISTEN ${judgeQueue.QUEUE_CHANNEL}`);
      if (!this.running) {
        await client.end().catch(() => {});
        return;
      }
      this.listener = client;
      // Catch up on anything enqueued while we were not listening.
      this.wake();
    } catch (error) {
      logger.warn({ error: (error as Error).message }, 'Could not open LISTEN connection; polling only for now');
      client.end().catch(() => {});
      this.scheduleListenerReconnect();
    }
  }

  private scheduleListenerReconnect(): void {
    if (!this.running || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.running) void this.connectListener();
    }, LISTEN_RETRY_MS);
  }
}
