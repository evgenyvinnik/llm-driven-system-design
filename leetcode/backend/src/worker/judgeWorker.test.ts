import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Pool } from 'pg';
import type { ClaimedJob } from '../shared/judgeQueue.js';
import type { Sandbox } from '../services/judge.js';

vi.mock('../db/pool.js', () => ({ default: {}, dbConfig: {} }));
vi.mock('../shared/submissionStatus.js', () => ({
  cacheProgress: vi.fn().mockResolvedValue(undefined),
  cacheVerdict: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../shared/metrics.js', () => {
  const counter = () => ({ inc: vi.fn(), dec: vi.fn(), set: vi.fn(), observe: vi.fn() });
  return {
    metrics: {
      submissionsInProgress: counter(),
      judgeQueueDepth: counter(),
      judgeQueueWait: counter(),
      judgeJobsTotal: counter(),
      submissionsTotal: counter(),
    },
  };
});

import { JudgeWorker, retryDelayMs, type JudgeWorkerOptions } from './judgeWorker.js';
import { SandboxUnavailableError } from '../services/codeExecutor.js';
import { cacheVerdict } from '../shared/submissionStatus.js';

const OPTIONS: JudgeWorkerOptions = {
  workerId: 'test-worker',
  concurrency: 1,
  leaseMs: 30000,
  pollIntervalMs: 10,
  maxAttempts: 3,
  languages: null,
};

function job(overrides: Partial<ClaimedJob> = {}): ClaimedJob {
  return {
    submissionId: 'sub-1',
    userId: 'user-1',
    problemId: 'problem-1',
    language: 'python',
    code: 'print(int(input()) * 2)',
    leaseToken: 7,
    judgeAttempts: 1,
    waitSeconds: 0.2,
    ...overrides,
  };
}

/** Pool that answers the worker's two problem queries. */
const pool = {
  query: vi.fn(async (sql: string) => {
    if (sql.includes('FROM problems')) {
      return { rows: [{ time_limit_ms: 2000, memory_limit_mb: 256, checker: 'exact', difficulty: 'easy' }] };
    }
    return { rows: [{ input: '21', expected_output: '42' }] };
  }),
} as unknown as Pool;

function queueWith(claimed: ClaimedJob) {
  return {
    claimJobs: vi.fn().mockResolvedValueOnce([claimed]).mockResolvedValue([]),
    extendLease: vi.fn().mockResolvedValue(true),
    completeJob: vi.fn().mockResolvedValue(true),
    retryJob: vi.fn().mockResolvedValue(true),
    releaseJob: vi.fn().mockResolvedValue(true),
    countPending: vi.fn().mockResolvedValue(0),
  };
}

function sandboxReturning(stdout: string): Sandbox {
  return {
    prepare: vi.fn().mockResolvedValue({ id: 'p', language: 'python', workDir: '/tmp/p' }),
    run: vi.fn().mockResolvedValue({ status: 'success', stdout, stderr: '', exitCode: 0, executionTime: 12 }),
    dispose: vi.fn().mockResolvedValue(undefined),
  };
}

async function runOnce(queue: ReturnType<typeof queueWith>, sandbox: Sandbox, waitFor: () => void): Promise<void> {
  const worker = new JudgeWorker(pool, sandbox, OPTIONS, queue, false);
  await worker.start();
  await vi.waitFor(waitFor);
  await worker.stop();
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('JudgeWorker', () => {
  it('judges a claimed job, commits the verdict with its lease token, then caches it', async () => {
    const queue = queueWith(job());

    await runOnce(queue, sandboxReturning('42'), () => expect(cacheVerdict).toHaveBeenCalled());

    const [, committedJob, verdict] = queue.completeJob.mock.calls[0];
    expect(committedJob.leaseToken).toBe(7);
    expect(verdict).toMatchObject({ status: 'accepted', testCasesPassed: 1, testCasesTotal: 1 });
    expect(cacheVerdict).toHaveBeenCalledWith('sub-1', expect.objectContaining({ status: 'accepted', user_id: 'user-1' }));
  });

  it('puts the job back with a backoff when the sandbox is unavailable', async () => {
    const queue = queueWith(job({ judgeAttempts: 1 }));
    const sandbox = sandboxReturning('42');
    vi.mocked(sandbox.prepare).mockRejectedValue(new SandboxUnavailableError('Docker is unavailable', { retryAfterMs: 5000 }));

    await runOnce(queue, sandbox, () => expect(queue.retryJob).toHaveBeenCalled());

    const [, , delayMs, message] = queue.retryJob.mock.calls[0];
    expect(delayMs).toBeGreaterThanOrEqual(5000);
    expect(message).toContain('attempt 1 of 3');
    expect(queue.completeJob).not.toHaveBeenCalled();
  });

  it('dead-letters the job as system_error once its attempts are used up', async () => {
    const queue = queueWith(job({ judgeAttempts: 3 }));
    const sandbox = sandboxReturning('42');
    vi.mocked(sandbox.prepare).mockRejectedValue(new SandboxUnavailableError('Docker is unavailable'));

    await runOnce(queue, sandbox, () => expect(queue.completeJob).toHaveBeenCalled());

    expect(queue.retryJob).not.toHaveBeenCalled();
    expect(queue.completeJob.mock.calls[0][2]).toMatchObject({ status: 'system_error', errorMessage: 'Judging failed after 3 attempts; please resubmit' });
  });

  it('does not even start a job that already exceeded its attempts (crash loop)', async () => {
    const queue = queueWith(job({ judgeAttempts: 4 }));
    const sandbox = sandboxReturning('42');

    await runOnce(queue, sandbox, () => expect(queue.completeJob).toHaveBeenCalled());

    expect(sandbox.prepare).not.toHaveBeenCalled();
    expect(queue.completeJob.mock.calls[0][2].status).toBe('system_error');
  });

  it('discards the verdict when the fenced write finds the lease taken over', async () => {
    const queue = queueWith(job());
    queue.completeJob.mockResolvedValue(false);

    await runOnce(queue, sandboxReturning('42'), () => expect(queue.completeJob).toHaveBeenCalled());

    expect(cacheVerdict).not.toHaveBeenCalled();
  });
});

describe('retryDelayMs', () => {
  it('backs off exponentially and respects the breaker reset time', () => {
    const plain = new Error('boom');
    expect(retryDelayMs(1, plain)).toBeGreaterThanOrEqual(4000);
    expect(retryDelayMs(1, plain)).toBeLessThanOrEqual(6000);
    expect(retryDelayMs(3, plain)).toBeGreaterThanOrEqual(16000);
    expect(retryDelayMs(10, plain)).toBeLessThanOrEqual(72000);
    expect(retryDelayMs(1, new SandboxUnavailableError('open', { breakerOpen: true, retryAfterMs: 30000 }))).toBeGreaterThanOrEqual(30000);
  });
});
