/**
 * Integration tests for the PostgreSQL execution queue and the firing transaction.
 *
 * These exercise real row locks, so they need a real database. They run only when
 * TEST_DATABASE_URL points at a disposable database (every test TRUNCATEs the tables):
 *
 *   createdb job_scheduler_test
 *   TEST_DATABASE_URL=postgres://scheduler:scheduler@localhost:5432/job_scheduler_test npm test
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;

type Pool = typeof import('./pool');
type Queue = typeof import('./execution-queue');
type Schedule = typeof import('./schedule-repository');

describeWithDb('execution queue against PostgreSQL', () => {
  let pool: Pool;
  let q: Queue;
  let schedule: Schedule;

  beforeAll(async () => {
    // pool.ts reads DATABASE_URL when it is first imported, so import dynamically.
    process.env.DATABASE_URL = TEST_DATABASE_URL;
    pool = await import('./pool');
    q = await import('./execution-queue');
    schedule = await import('./schedule-repository');
    const { migrate } = await import('./migrate');
    await migrate();
  });

  afterAll(async () => {
    await pool?.pool.end();
  });

  beforeEach(async () => {
    await pool.query('TRUNCATE jobs, job_executions, execution_logs CASCADE');
  });

  /** Inserts a job and returns its id. */
  async function createJob(fields: Record<string, unknown> = {}): Promise<string> {
    const columns = { name: `job-${Math.random().toString(36).slice(2)}`, handler: 'test.echo', ...fields };
    const names = Object.keys(columns);
    const rows = await pool.query<{ id: string }>(
      `INSERT INTO jobs (${names.join(', ')}) VALUES (${names.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`,
      Object.values(columns)
    );
    return rows[0].id;
  }

  /** Inserts PENDING executions for a job (distinct slots, runnable now). */
  async function addPending(jobId: string, count: number, priority = 50): Promise<void> {
    await pool.query(
      `INSERT INTO job_executions (job_id, status, attempt, scheduled_at, run_at, priority)
       SELECT $1, 'PENDING', 1, NOW() - (n * INTERVAL '1 second'), NOW() - INTERVAL '1 second', $3
       FROM generate_series(1, $2) AS n`,
      [jobId, count, priority]
    );
  }

  async function statusOf(executionId: string): Promise<string> {
    const rows = await pool.query<{ status: string }>('SELECT status FROM job_executions WHERE id = $1', [executionId]);
    return rows[0].status;
  }

  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  it('never hands one execution to two concurrent workers', async () => {
    const jobId = await createJob();
    await addPending(jobId, 60);

    // Four workers claim in batches of 3 at the same time until the queue is empty.
    const claimedBy = new Map<string, string>();
    const tokens = new Set<string>();
    await Promise.all(['w1', 'w2', 'w3', 'w4'].map(async (worker) => {
      for (;;) {
        const batch = await q.claimExecutions(worker, 3, 30_000);
        if (batch.length === 0) return;
        for (const execution of batch) {
          expect(claimedBy.has(execution.id)).toBe(false);
          claimedBy.set(execution.id, worker);
          tokens.add(execution.fencing_token);
        }
      }
    }));

    expect(claimedBy.size).toBe(60);
    expect(tokens.size).toBe(60);
    expect(new Set(claimedBy.values()).size).toBeGreaterThan(1);
    const running = await pool.query<{ n: string }>(`SELECT COUNT(*) AS n FROM job_executions WHERE status = 'RUNNING'`);
    expect(running[0].n).toBe('60');
  });

  it('claims the highest priority first and skips paused jobs and future run_at', async () => {
    const low = await createJob({ priority: 10 });
    const high = await createJob({ priority: 90 });
    const paused = await createJob({ priority: 100, status: 'PAUSED' });
    await addPending(low, 1, 10);
    await addPending(high, 1, 90);
    await addPending(paused, 1, 100);
    await pool.query(
      `INSERT INTO job_executions (job_id, status, attempt, scheduled_at, run_at, priority)
       VALUES ($1, 'PENDING', 1, NOW(), NOW() + INTERVAL '1 hour', 95)`,
      [high]
    );

    const [first] = await q.claimExecutions('w1', 1, 30_000);
    expect(first.job_id).toBe(high);
    const rest = await q.claimExecutions('w1', 10, 30_000);
    expect(rest.map((execution) => execution.job_id)).toEqual([low]);
  });

  it('accepts the outcome only from the current lease holder', async () => {
    const jobId = await createJob();
    await addPending(jobId, 1);
    const [execution] = await q.claimExecutions('w1', 1, 30_000);
    const lease = { executionId: execution.id, fencingToken: execution.fencing_token };

    const forged = { executionId: execution.id, fencingToken: String(BigInt(execution.fencing_token) - 1n) };
    expect(await q.completeExecution(forged, { ok: true })).toBe(false);
    expect(await q.completeExecution(lease, { ok: true })).toBe(true);
    expect(await q.completeExecution(lease, { ok: 'again' })).toBe(false);
    expect(await statusOf(execution.id)).toBe('COMPLETED');
  });

  it('reaps a lapsed lease as a failed attempt and fences out the stale worker', async () => {
    const jobId = await createJob({ max_retries: 2, initial_backoff_ms: 100, max_backoff_ms: 1000 });
    await addPending(jobId, 1);
    const [execution] = await q.claimExecutions('w1', 1, 50);
    const staleLease = { executionId: execution.id, fencingToken: execution.fencing_token };

    await sleep(80); // w1 "stalls" past its 50 ms lease
    const reaped = await q.reapExpiredLeases(10);
    expect(reaped).toHaveLength(1);
    expect(reaped[0].outcome).toMatchObject({ outcome: 'retry', nextAttempt: 2 });

    // The stalled worker wakes up: renewal and completion are both refused.
    expect((await q.renewLeases([staleLease], 30_000)).size).toBe(0);
    expect(await q.completeExecution(staleLease, { late: true })).toBe(false);
    expect(await q.failExecution(staleLease, 'late failure', true)).toBeNull();

    const attempts = await pool.query<{ attempt: number; status: string; error: string | null }>(
      'SELECT attempt, status, error FROM job_executions WHERE job_id = $1 ORDER BY attempt', [jobId]
    );
    expect(attempts.map((row) => [row.attempt, row.status])).toEqual([[1, 'FAILED'], [2, 'PENDING']]);
    expect(attempts[0].error).toMatch(/Lease expired: worker w1/);

    // The retry becomes claimable after its backoff, under a larger fencing token.
    await sleep(120);
    const [retry] = await q.claimExecutions('w2', 1, 30_000);
    expect(retry.attempt).toBe(2);
    expect(BigInt(retry.fencing_token)).toBeGreaterThan(BigInt(execution.fencing_token));
  });

  it('dead-letters when retries run out or the error is not retryable', async () => {
    const jobId = await createJob({ max_retries: 0 });
    await addPending(jobId, 2);
    const [a, b] = await q.claimExecutions('w1', 2, 30_000);

    expect(await q.failExecution({ executionId: a.id, fencingToken: a.fencing_token }, 'boom', true))
      .toEqual({ outcome: 'dead_letter' });
    expect(await statusOf(a.id)).toBe('DEAD_LETTER');

    const retryJob = await createJob({ max_retries: 5 });
    await addPending(retryJob, 1);
    const [c] = await q.claimExecutions('w1', 1, 30_000);
    expect(await q.failExecution({ executionId: c.id, fencingToken: c.fencing_token }, 'bad payload', false))
      .toEqual({ outcome: 'dead_letter' });

    const stats = await q.getQueueStats();
    expect(stats.deadLetter).toBe(2);
    expect(stats.processing).toBe(1); // b is still running
    expect(b.status).toBe('RUNNING');
  });

  it('stops a cancelled execution: renewal fails and the result is rejected', async () => {
    const jobId = await createJob();
    await addPending(jobId, 1);
    const [execution] = await q.claimExecutions('w1', 1, 30_000);
    const lease = { executionId: execution.id, fencingToken: execution.fencing_token };

    expect((await q.cancelExecution(execution.id))?.status).toBe('CANCELLED');
    expect(await q.cancelExecution(execution.id)).toBeNull();
    expect((await q.renewLeases([lease], 30_000)).has(execution.id)).toBe(false);
    expect(await q.completeExecution(lease, {})).toBe(false);
    expect(await statusOf(execution.id)).toBe('CANCELLED');
  });

  it('releases a claim without consuming an attempt', async () => {
    const jobId = await createJob();
    await addPending(jobId, 1);
    const [execution] = await q.claimExecutions('w1', 1, 30_000);
    const lease = { executionId: execution.id, fencingToken: execution.fencing_token };

    expect(await q.releaseExecution(lease, 0)).toBe(true);
    const [again] = await q.claimExecutions('w2', 1, 30_000);
    expect(again.id).toBe(execution.id);
    expect(again.attempt).toBe(1);
    expect(await q.completeExecution(lease, {})).toBe(false);
    expect(await q.completeExecution({ executionId: again.id, fencingToken: again.fencing_token }, {})).toBe(true);
  });

  it('redrives a dead-lettered run once, as its next attempt', async () => {
    const jobId = await createJob({ max_retries: 0 });
    await addPending(jobId, 1);
    const [execution] = await q.claimExecutions('w1', 1, 30_000);
    await q.failExecution({ executionId: execution.id, fencingToken: execution.fencing_token }, 'boom', true);

    const first = await q.redriveExecution(execution.id);
    expect(first.ok && first.execution.attempt).toBe(2);
    expect(await statusOf(execution.id)).toBe('FAILED');
    expect(await q.redriveExecution(execution.id)).toEqual({ ok: false, reason: 'superseded' });
  });

  it('gives every concurrent manual trigger its own run', async () => {
    const jobId = await createJob();
    const runs = await Promise.all(Array.from({ length: 40 }, () => q.enqueueManualRun(jobId, 50)));
    expect(new Set(runs.map((run) => run.id)).size).toBe(40);
    const slots = await pool.query<{ n: string }>(
      'SELECT COUNT(DISTINCT scheduled_at) AS n FROM job_executions WHERE job_id = $1', [jobId]
    );
    expect(slots[0].n).toBe('40');
  });

  it('fires each due slot once even when two schedulers run at the same time', async () => {
    const recurring = await Promise.all(
      // Yearly, so the slot after the fired one is never already due again.
      Array.from({ length: 20 }, () => createJob({
        schedule: '0 0 1 1 *',
        next_run_time: new Date(Date.now() - 5_000),
      }))
    );
    const oneTime = await createJob({ next_run_time: new Date(Date.now() - 1_000) });

    const [a, b] = await Promise.all([
      schedule.fireDueJobs(500, 60_000),
      schedule.fireDueJobs(500, 60_000),
    ]);
    expect(a.fired + b.fired).toBe(21);

    const perJob = await pool.query<{ job_id: string; n: string }>(
      'SELECT job_id, COUNT(*) AS n FROM job_executions GROUP BY job_id'
    );
    expect(perJob).toHaveLength(21);
    expect(perJob.every((row) => row.n === '1')).toBe(true);

    const jobs = await pool.query<{ id: string; status: string; next_run_time: Date | null }>(
      'SELECT id, status, next_run_time FROM jobs'
    );
    for (const job of jobs) {
      if (recurring.includes(job.id)) {
        expect(job.status).toBe('SCHEDULED');
        expect(job.next_run_time!.getTime()).toBeGreaterThan(Date.now());
      } else {
        expect(job.id).toBe(oneTime);
        expect(job.status).toBe('QUEUED');
        expect(job.next_run_time).toBeNull();
      }
    }

    // Nothing is due any more: a second pass fires nothing.
    expect((await schedule.fireDueJobs(500, 60_000)).fired).toBe(0);
  });

  it('applies the misfire policy and never strands a job in the past', async () => {
    const twoHoursAgo = new Date(Date.now() - 2 * 3_600_000);
    const fireOnce = await createJob({ schedule: '* * * * *', next_run_time: twoHoursAgo });
    const skip = await createJob({ schedule: '* * * * *', next_run_time: twoHoursAgo, misfire_policy: 'skip' });

    const summary = await schedule.fireDueJobs(500, 60_000);
    expect(summary).toMatchObject({ jobs: 2, fired: 1, misfired: 2, skipped: 1 });

    const executions = await pool.query<{ job_id: string; scheduled_at: Date }>('SELECT job_id, scheduled_at FROM job_executions');
    expect(executions).toHaveLength(1);
    expect(executions[0].job_id).toBe(fireOnce);
    expect(executions[0].scheduled_at.getTime()).toBe(twoHoursAgo.getTime());

    const jobs = await pool.query<{ id: string; next_run_time: Date }>('SELECT id, next_run_time FROM jobs WHERE id = ANY($1)', [[fireOnce, skip]]);
    for (const job of jobs) {
      expect(job.next_run_time.getTime()).toBeGreaterThan(Date.now());
    }
  });
});
