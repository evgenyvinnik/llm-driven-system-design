import { describe, it, expect, vi } from 'vitest';
import { judgeSubmission, JudgeAbortedError, type JudgeProblem, type Sandbox } from './judge.js';
import type { RunResult } from './codeExecutor.js';

function problem(overrides: Partial<JudgeProblem> = {}): JudgeProblem {
  return {
    timeLimitMs: 2000,
    memoryLimitMb: 256,
    checker: 'exact',
    testCases: [
      { input: '1', expectedOutput: '2' },
      { input: '2', expectedOutput: '4' },
      { input: '3', expectedOutput: '6' },
    ],
    ...overrides,
  };
}

function sandbox(results: Array<Partial<RunResult>>, compileError?: string) {
  const run = vi.fn();
  for (const result of results) {
    run.mockResolvedValueOnce({ status: 'success', stdout: '', stderr: '', exitCode: 0, executionTime: 10, ...result });
  }
  const fake = {
    prepare: vi.fn().mockResolvedValue({ id: 'p1', language: 'python', workDir: '/tmp/p1', compileError }),
    run,
    dispose: vi.fn().mockResolvedValue(undefined),
  };
  return fake as typeof fake & Sandbox;
}

const submission = { code: 'print(int(input()) * 2)', language: 'python' };

describe('judgeSubmission', () => {
  it('accepts when every test passes and reports the slowest test as the runtime', async () => {
    const fake = sandbox([
      { stdout: '2\n', executionTime: 30 },
      { stdout: '4\n', executionTime: 80 },
      { stdout: '6\n', executionTime: 50 },
    ]);

    const verdict = await judgeSubmission(submission, problem(), fake);

    expect(verdict).toMatchObject({ status: 'accepted', testCasesPassed: 3, testCasesTotal: 3, runtimeMs: 80, errorMessage: null });
    expect(fake.prepare).toHaveBeenCalledTimes(1);
    expect(fake.dispose).toHaveBeenCalledTimes(1);
  });

  it('stops at the first wrong answer and names the test', async () => {
    const fake = sandbox([{ stdout: '2' }, { stdout: '5' }, { stdout: '6' }]);

    const verdict = await judgeSubmission(submission, problem(), fake);

    expect(verdict.status).toBe('wrong_answer');
    expect(verdict.testCasesPassed).toBe(1);
    expect(verdict.errorMessage).toBe('Wrong answer on test 2. Expected: 4, Got: 5');
    expect(fake.run).toHaveBeenCalledTimes(2);
  });

  it('turns resource failures into verdicts with the test number', async () => {
    const tle = await judgeSubmission(submission, problem(), sandbox([{ status: 'time_limit_exceeded', exitCode: 137 }]));
    expect(tle).toMatchObject({ status: 'time_limit_exceeded', errorMessage: 'Time limit exceeded on test 1' });

    const runtime = await judgeSubmission(
      submission,
      problem(),
      sandbox([{ stdout: '2' }, { status: 'runtime_error', exitCode: 1, stderr: 'Traceback...\nZeroDivisionError: division by zero\n' }])
    );
    expect(runtime.status).toBe('runtime_error');
    expect(runtime.errorMessage).toMatch(/^Runtime error on test 2: .*ZeroDivisionError: division by zero$/s);
  });

  it('returns a compile error without running any test', async () => {
    const fake = sandbox([], 'error: expected ; before }');

    const verdict = await judgeSubmission({ code: 'int main() {', language: 'cpp' }, problem(), fake);

    expect(verdict).toMatchObject({ status: 'compile_error', testCasesPassed: 0, testCasesTotal: 3, errorMessage: 'error: expected ; before }' });
    expect(fake.run).not.toHaveBeenCalled();
    expect(fake.dispose).toHaveBeenCalled();
  });

  it("uses the problem's checker", async () => {
    const twoSum = problem({ checker: 'unordered', testCases: [{ input: '[2,7,11,15]\n9', expectedOutput: '[0,1]' }] });

    const verdict = await judgeSubmission(submission, twoSum, sandbox([{ stdout: '[1, 0]' }]));

    expect(verdict.status).toBe('accepted');
  });

  it('reports progress before each test', async () => {
    const onProgress = vi.fn();

    await judgeSubmission(submission, problem(), sandbox([{ stdout: '2' }, { stdout: '4' }, { stdout: '6' }]), { onProgress });

    expect(onProgress.mock.calls.map(([progress]) => progress.currentTest)).toEqual([1, 2, 3]);
    expect(onProgress).toHaveBeenLastCalledWith({ currentTest: 3, testCasesPassed: 2, testCasesTotal: 3 });
  });

  it('aborts between tests when the worker may no longer finish, and still cleans up', async () => {
    const fake = sandbox([{ stdout: '2' }, { stdout: '4' }]);
    let allowed = 1;

    await expect(judgeSubmission(submission, problem(), fake, { shouldContinue: () => allowed-- > 0 }))
      .rejects.toBeInstanceOf(JudgeAbortedError);
    expect(fake.run).toHaveBeenCalledTimes(1);
    expect(fake.dispose).toHaveBeenCalled();
  });

  it('lets sandbox failures propagate so the job can be retried', async () => {
    const fake = sandbox([]);
    fake.prepare.mockRejectedValue(new Error('Docker is unavailable'));

    await expect(judgeSubmission(submission, problem(), fake)).rejects.toThrow('Docker is unavailable');
  });

  it('refuses to accept a problem with no test data', async () => {
    const fake = sandbox([]);

    const verdict = await judgeSubmission(submission, problem({ testCases: [] }), fake);

    expect(verdict).toMatchObject({ status: 'system_error', errorMessage: 'Problem has no test cases' });
    expect(fake.prepare).not.toHaveBeenCalled();
  });
});
