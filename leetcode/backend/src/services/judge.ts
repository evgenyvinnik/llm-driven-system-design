import { compareOutput, type CheckerMode } from './checker.js';
import type { PreparedProgram, RunLimits, RunResult, RunStatus } from './codeExecutor.js';

/** Final verdicts stored in submissions.status. */
export type FinalStatus =
  | 'accepted'
  | 'wrong_answer'
  | 'time_limit_exceeded'
  | 'memory_limit_exceeded'
  | 'output_limit_exceeded'
  | 'runtime_error'
  | 'compile_error'
  | 'system_error';

export interface JudgeTestCase {
  input: string;
  expectedOutput: string;
}

export interface JudgeProblem {
  timeLimitMs: number;
  memoryLimitMb: number;
  checker: CheckerMode;
  testCases: JudgeTestCase[];
}

export interface Verdict {
  status: FinalStatus;
  testCasesPassed: number;
  testCasesTotal: number;
  /** Slowest test, in milliseconds; null when nothing ran. */
  runtimeMs: number | null;
  /** Not measured by the Docker sandbox yet; always null. */
  memoryKb: number | null;
  errorMessage: string | null;
}

export interface JudgeProgress {
  currentTest: number;
  testCasesPassed: number;
  testCasesTotal: number;
}

/** The part of the code executor the judge needs; tests pass a fake. */
export interface Sandbox {
  prepare(code: string, language: string): Promise<PreparedProgram>;
  run(program: PreparedProgram, input: string, limits: RunLimits): Promise<RunResult>;
  dispose(program: PreparedProgram): Promise<void>;
}

export interface JudgeHooks {
  /** Called before each test; used to publish "running test 3 of 10". */
  onProgress?: (progress: JudgeProgress) => void | Promise<void>;
  /** Checked before each test; false means the lease was lost or the worker is stopping. */
  shouldContinue?: () => boolean;
}

/** Judging stopped before a verdict because this worker may no longer finish the job. */
export class JudgeAbortedError extends Error {
  constructor() {
    super('Judging aborted: lease lost or worker stopping');
    this.name = 'JudgeAbortedError';
  }
}

const FAILURE_LABEL: Record<Exclude<RunStatus, 'success'>, string> = {
  time_limit_exceeded: 'Time limit exceeded',
  memory_limit_exceeded: 'Memory limit exceeded',
  output_limit_exceeded: 'Output limit exceeded',
  runtime_error: 'Runtime error'
};

function preview(text: string): string {
  const oneLine = text.trim();
  return oneLine.length > 100 ? `${oneLine.slice(0, 100)}...` : oneLine;
}

/**
 * Judges one submission: compile once, then run the test cases in order and stop at the first
 * failure. Tests run one at a time on purpose: parallel tests would compete for the same CPU
 * quota and make the measured runtime depend on what else was running.
 *
 * Throws SandboxUnavailableError when the sandbox itself fails (the caller retries later) and
 * JudgeAbortedError when shouldContinue() turns false. Every other outcome is a verdict.
 */
export async function judgeSubmission(
  submission: { code: string; language: string },
  problem: JudgeProblem,
  sandbox: Sandbox,
  hooks: JudgeHooks = {}
): Promise<Verdict> {
  const total = problem.testCases.length;
  if (total === 0) {
    return {
      status: 'system_error',
      testCasesPassed: 0,
      testCasesTotal: 0,
      runtimeMs: null,
      memoryKb: null,
      errorMessage: 'Problem has no test cases'
    };
  }

  const program = await sandbox.prepare(submission.code, submission.language);
  try {
    if (program.compileError !== undefined) {
      return {
        status: 'compile_error',
        testCasesPassed: 0,
        testCasesTotal: total,
        runtimeMs: null,
        memoryKb: null,
        errorMessage: program.compileError
      };
    }

    const limits: RunLimits = { timeLimitMs: problem.timeLimitMs, memoryLimitMb: problem.memoryLimitMb };
    let passed = 0;
    let slowestMs = 0;

    for (const [index, testCase] of problem.testCases.entries()) {
      if (hooks.shouldContinue && !hooks.shouldContinue()) {
        throw new JudgeAbortedError();
      }
      await hooks.onProgress?.({ currentTest: index + 1, testCasesPassed: passed, testCasesTotal: total });

      const result = await sandbox.run(program, testCase.input, limits);
      slowestMs = Math.max(slowestMs, result.executionTime);
      const testNumber = index + 1;

      if (result.status !== 'success') {
        const stderr = result.stderr.trim();
        const detail = result.status === 'runtime_error' && stderr ? `: ${stderr.slice(-500)}` : '';
        return {
          status: result.status,
          testCasesPassed: passed,
          testCasesTotal: total,
          runtimeMs: slowestMs,
          memoryKb: null,
          errorMessage: `${FAILURE_LABEL[result.status]} on test ${testNumber}${detail}`
        };
      }

      if (!compareOutput(result.stdout, testCase.expectedOutput, problem.checker)) {
        return {
          status: 'wrong_answer',
          testCasesPassed: passed,
          testCasesTotal: total,
          runtimeMs: slowestMs,
          memoryKb: null,
          errorMessage: `Wrong answer on test ${testNumber}. Expected: ${preview(testCase.expectedOutput)}, Got: ${preview(result.stdout)}`
        };
      }

      passed++;
    }

    return {
      status: 'accepted',
      testCasesPassed: passed,
      testCasesTotal: total,
      runtimeMs: slowestMs,
      memoryKb: null,
      errorMessage: null
    };
  } finally {
    await sandbox.dispose(program);
  }
}
