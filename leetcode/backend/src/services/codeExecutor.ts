import Docker from 'dockerode';
import { v4 as uuidv4 } from 'uuid';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import type CircuitBreaker from 'opossum';

import { createModuleLogger } from '../shared/logger.js';
import { metrics } from '../shared/metrics.js';
import { createExecutionCircuitBreaker } from '../shared/circuitBreaker.js';
import { DockerStreamDemuxer, type OutputLimits } from './dockerStream.js';

const logger = createModuleLogger('code-executor');
const docker = new Docker();

interface LanguageConfig {
  image: string;
  fileName: string;
  compileCommand?: string[];
  runCommand: string[];
  /** Upper bound on the per-test time limit for this language, in milliseconds. */
  timeoutMs: number;
  /** Upper bound on the per-test memory limit for this language, in megabytes. */
  memoryMb: number;
}

// Resource limits per language
const LANGUAGE_CONFIG: Record<string, LanguageConfig> = {
  python: {
    image: 'python:3.11-alpine',
    fileName: 'solution.py',
    runCommand: ['python3', '/code/solution.py'],
    timeoutMs: 10000,
    memoryMb: 256
  },
  javascript: {
    image: 'node:20-alpine',
    fileName: 'solution.js',
    runCommand: ['node', '/code/solution.js'],
    timeoutMs: 8000,
    memoryMb: 256
  },
  cpp: {
    image: 'gcc:13',
    fileName: 'solution.cpp',
    compileCommand: ['g++', '-O2', '-std=c++17', '-o', '/code/solution', '/code/solution.cpp'],
    runCommand: ['/code/solution'],
    timeoutMs: 15000,
    memoryMb: 512
  },
  java: {
    image: 'openjdk:21-slim',
    fileName: 'Solution.java',
    compileCommand: ['javac', '/code/Solution.java'],
    runCommand: ['java', '-cp', '/code', 'Solution'],
    timeoutMs: 15000,
    memoryMb: 512
  }
};

/** Languages the sandbox can compile and run. */
export const SUPPORTED_LANGUAGES = Object.keys(LANGUAGE_CONFIG);

const MB = 1024 * 1024;
const COMPILE_TIMEOUT_MS = 30000;
const COMPILE_MEMORY_MB = 512;
/** Grace period on top of the time limit before a container that will not exit is abandoned. */
const WAIT_GRACE_MS = 10000;
/** How long to wait for the last output frames after the process exits. */
const STREAM_DRAIN_MS = 500;
const RUN_OUTPUT_LIMITS: OutputLimits = { stdoutBytes: 1 * MB, stderrBytes: 64 * 1024 };
const COMPILE_OUTPUT_LIMITS: OutputLimits = { stdoutBytes: 64 * 1024, stderrBytes: 64 * 1024 };

/** Unprivileged uid:gid inside the container ("nobody"); the code never runs as root. */
const SANDBOX_USER = process.env.SANDBOX_USER || '65534:65534';
/** Optional OCI runtime, e.g. "runsc" to run every container under gVisor. */
const SANDBOX_RUNTIME = process.env.SANDBOX_RUNTIME || undefined;
/** Containers this process may run at once, across judging and sample runs. */
const SANDBOX_MAX_CONTAINERS = parseInt(process.env.SANDBOX_MAX_CONTAINERS || '4', 10);

const LABEL_SANDBOX = 'leetcode.sandbox';
const LABEL_OWNER = 'leetcode.owner';

const OUT_OF_MEMORY = /java\.lang\.OutOfMemoryError|\bMemoryError\b|JavaScript heap out of memory|std::bad_alloc/;

/** Outcome of one test run, as seen by the judge. */
export type RunStatus =
  | 'success'
  | 'time_limit_exceeded'
  | 'memory_limit_exceeded'
  | 'output_limit_exceeded'
  | 'runtime_error';

export interface RunLimits {
  timeLimitMs: number;
  memoryLimitMb: number;
}

export interface RunResult {
  status: RunStatus;
  stdout: string;
  stderr: string;
  exitCode: number;
  executionTime: number;
}

/** Code written to disk and, for compiled languages, compiled once for all test cases. */
export interface PreparedProgram {
  id: string;
  language: string;
  workDir: string;
  /** Compiler output when compilation failed; the program must not be run. */
  compileError?: string;
}

/** Everything one sandbox container needs. */
export interface ContainerSpec {
  image: string;
  cmd: string[];
  workDir: string;
  /** Mount /code read-write (compile step) instead of read-only (test runs). */
  writableCode: boolean;
  memoryMb: number;
  timeoutMs: number;
  stdin: string;
  outputLimits: OutputLimits;
}

/** What happened inside one container; turned into a RunStatus by classifyRun. */
export interface ContainerOutcome {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
  oomKilled: boolean;
  outputLimitExceeded: boolean;
  durationMs: number;
}

/**
 * The sandbox itself failed (Docker unreachable, image missing, circuit open). This is never
 * the user's fault, so callers retry later instead of recording a verdict.
 */
export class SandboxUnavailableError extends Error {
  readonly breakerOpen: boolean;
  readonly retryAfterMs: number;

  constructor(message: string, options: { breakerOpen?: boolean; retryAfterMs?: number } = {}) {
    super(message);
    this.name = 'SandboxUnavailableError';
    this.breakerOpen = options.breakerOpen ?? false;
    this.retryAfterMs = options.retryAfterMs ?? 5000;
  }
}

/** Maps a container outcome to a verdict for one test. Order matters: the first match wins. */
export function classifyRun(outcome: Pick<ContainerOutcome, 'outputLimitExceeded' | 'timedOut' | 'oomKilled' | 'exitCode' | 'stderr'>): RunStatus {
  // We killed it for printing too much, or for running too long: those explain the exit code.
  if (outcome.outputLimitExceeded) return 'output_limit_exceeded';
  if (outcome.timedOut) return 'time_limit_exceeded';
  // The kernel OOM killer (exit 137, OOMKilled) or a runtime that reports its own heap exhaustion.
  if (outcome.oomKilled) return 'memory_limit_exceeded';
  if (outcome.exitCode !== 0 && OUT_OF_MEMORY.test(outcome.stderr)) return 'memory_limit_exceeded';
  if (outcome.exitCode !== 0) return 'runtime_error';
  return 'success';
}

/** Counting semaphore that bounds concurrent containers on this host. */
class Semaphore {
  private available: number;
  private readonly waiters: Array<() => void> = [];

  constructor(size: number) {
    this.available = Math.max(1, size);
  }

  async acquire(): Promise<() => void> {
    if (this.available > 0) {
      this.available--;
    } else {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiters.shift();
      if (next) next();
      else this.available++;
    };
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** Executes user code in sandboxed Docker containers with resource limits and circuit breaker protection. */
class CodeExecutor {
  private tempDir: string;
  private circuitBreaker: CircuitBreaker<[ContainerSpec], ContainerOutcome> | null;
  private ownerId = 'local';
  private readonly slots = new Semaphore(SANDBOX_MAX_CONTAINERS);
  private readonly pulls = new Map<string, Promise<void>>();

  constructor() {
    this.tempDir = path.join(os.tmpdir(), 'leetcode-sandbox');
    this.circuitBreaker = null;
  }

  /**
   * Prepares the executor. `ownerId` labels every container this process starts, so a
   * restarted process can remove containers its previous incarnation left running.
   */
  async init(ownerId = process.env.WORKER_ID || 'local'): Promise<void> {
    if (this.circuitBreaker) return;
    this.ownerId = ownerId;
    try {
      await fs.mkdir(this.tempDir, { recursive: true });
    } catch (error) {
      logger.error({ error: (error as Error).message }, 'Failed to create sandbox temp directory');
    }
    this.circuitBreaker = createExecutionCircuitBreaker((spec: ContainerSpec) => this.runContainerUnprotected(spec));
    logger.info({ tempDir: this.tempDir, ownerId, runtime: SANDBOX_RUNTIME ?? 'runc' }, 'Code executor initialized');
    this.removeOrphanedContainers().catch((error: Error) => {
      logger.warn({ error: error.message }, 'Could not check for orphaned sandbox containers');
    });
  }

  /** Writes the code and compiles it once; test cases then reuse the same build. */
  async prepare(code: string, language: string): Promise<PreparedProgram> {
    const config = LANGUAGE_CONFIG[language];
    if (!config) {
      throw new Error(`Unsupported language: ${language}`);
    }

    const id = uuidv4();
    const workDir = path.join(this.tempDir, id);
    await fs.mkdir(workDir, { recursive: true });
    // The sandbox user owns nothing on the host: it needs a world-writable directory only
    // when the compiler has to write its output next to the source.
    await fs.chmod(workDir, config.compileCommand ? 0o777 : 0o755);
    await fs.writeFile(path.join(workDir, config.fileName), code, { mode: 0o644 });

    const program: PreparedProgram = { id, language, workDir };
    try {
      await this.ensureImage(config.image);
      if (config.compileCommand) {
        const outcome = await this.runContainer({
          image: config.image,
          cmd: config.compileCommand,
          workDir,
          writableCode: true,
          memoryMb: COMPILE_MEMORY_MB,
          timeoutMs: COMPILE_TIMEOUT_MS,
          stdin: '',
          outputLimits: COMPILE_OUTPUT_LIMITS
        });
        if (outcome.timedOut) {
          program.compileError = 'Compilation timed out';
        } else if (outcome.exitCode !== 0) {
          program.compileError = (outcome.stderr || outcome.stdout || 'Compilation failed').slice(0, 2000);
        }
      }
      return program;
    } catch (error) {
      await this.dispose(program);
      throw error;
    }
  }

  /** Runs a prepared program against one input in a fresh container. */
  async run(program: PreparedProgram, input: string, limits: RunLimits): Promise<RunResult> {
    const config = LANGUAGE_CONFIG[program.language];
    if (program.compileError !== undefined) {
      throw new Error('Cannot run a program that failed to compile');
    }

    const outcome = await this.runContainer({
      image: config.image,
      cmd: config.runCommand,
      workDir: program.workDir,
      writableCode: false,
      memoryMb: Math.min(limits.memoryLimitMb, config.memoryMb),
      timeoutMs: Math.min(limits.timeLimitMs, config.timeoutMs),
      stdin: input,
      outputLimits: RUN_OUTPUT_LIMITS
    });

    const status = classifyRun(outcome);
    metrics.codeExecutionsTotal.inc({ status, language: program.language });
    metrics.codeExecutionDuration.observe({ language: program.language, status }, outcome.durationMs / 1000);

    return {
      status,
      stdout: outcome.stdout,
      stderr: outcome.stderr.slice(0, 1000),
      exitCode: outcome.exitCode,
      executionTime: outcome.durationMs
    };
  }

  /** Removes the program's files from the host. */
  async dispose(program: Pick<PreparedProgram, 'workDir'>): Promise<void> {
    try {
      await fs.rm(program.workDir, { recursive: true, force: true });
    } catch (error) {
      logger.warn({ error: (error as Error).message, workDir: program.workDir }, 'Cleanup error');
    }
  }

  /** Runs a container through the circuit breaker, turning infrastructure failures into SandboxUnavailableError. */
  private async runContainer(spec: ContainerSpec): Promise<ContainerOutcome> {
    if (!this.circuitBreaker) {
      throw new SandboxUnavailableError('Code executor is not initialized');
    }
    try {
      return await this.circuitBreaker.fire(spec);
    } catch (error) {
      if ((error as { code?: string }).code === 'EOPENBREAKER') {
        throw new SandboxUnavailableError('Code execution is temporarily unavailable', {
          breakerOpen: true,
          retryAfterMs: 30000
        });
      }
      throw new SandboxUnavailableError(`Sandbox failure: ${(error as Error).message}`);
    }
  }

  private containerOptions(spec: ContainerSpec): Docker.ContainerCreateOptions {
    return {
      Image: spec.image,
      Cmd: spec.cmd,
      WorkingDir: '/code',
      User: SANDBOX_USER,
      Labels: { [LABEL_SANDBOX]: 'true', [LABEL_OWNER]: this.ownerId },
      NetworkDisabled: true,
      OpenStdin: true,
      StdinOnce: true,
      AttachStdin: true,
      AttachStdout: true,
      AttachStderr: true,
      Tty: false,
      HostConfig: {
        Binds: [`${spec.workDir}:/code:${spec.writableCode ? 'rw' : 'ro'}`],
        Memory: spec.memoryMb * MB,
        MemorySwap: spec.memoryMb * MB, // No swap
        CpuPeriod: 100000,
        CpuQuota: 50000, // 50% of one CPU
        PidsLimit: 50,
        NetworkMode: 'none',
        // Nothing outside /tmp (a small tmpfs) and, while compiling, /code is writable
        ReadonlyRootfs: true,
        Tmpfs: { '/tmp': 'rw,nosuid,nodev,size=64m' },
        SecurityOpt: ['no-new-privileges'],
        CapDrop: ['ALL'],
        ...(SANDBOX_RUNTIME ? { Runtime: SANDBOX_RUNTIME } : {})
        // No AutoRemove: the container must still exist after it exits so we can read its
        // exit code and OOMKilled flag; it is removed explicitly in runContainerUnprotected.
      }
    };
  }

  private async runContainerUnprotected(spec: ContainerSpec): Promise<ContainerOutcome> {
    const release = await this.slots.acquire();
    metrics.activeContainers.inc();
    let container: Docker.Container | null = null;

    try {
      container = await docker.createContainer(this.containerOptions(spec));
      const running = container;

      // Attach before start so no output is lost; stdout and stderr arrive multiplexed.
      const stream = await running.attach({ stream: true, stdin: true, stdout: true, stderr: true });
      const demux = new DockerStreamDemuxer(spec.outputLimits);
      let killedForOutput = false;
      const streamEnded = new Promise<void>((resolve) => {
        stream.once('end', () => resolve());
        stream.once('close', () => resolve());
        stream.once('error', () => resolve());
      });
      stream.on('data', (chunk: Buffer) => {
        demux.push(chunk);
        if (demux.stdoutLimitExceeded && !killedForOutput) {
          killedForOutput = true;
          running.kill().catch(() => {});
        }
      });

      await running.start();
      const startedAt = Date.now();
      stream.write(spec.stdin);
      stream.end();

      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        running.kill().catch(() => {});
      }, spec.timeoutMs);

      let exit: { StatusCode: number };
      try {
        exit = await withTimeout(running.wait(), spec.timeoutMs + WAIT_GRACE_MS, 'Sandbox container did not exit after being killed');
      } finally {
        clearTimeout(timer);
      }
      const durationMs = Date.now() - startedAt;

      await Promise.race([streamEnded, delay(STREAM_DRAIN_MS)]);
      const info = await running.inspect();

      return {
        stdout: demux.stdout,
        stderr: demux.stderr,
        exitCode: exit.StatusCode,
        timedOut,
        oomKilled: info.State.OOMKilled === true,
        outputLimitExceeded: demux.stdoutLimitExceeded,
        durationMs
      };
    } finally {
      if (container) {
        await container.remove({ force: true }).catch(() => {});
      }
      metrics.activeContainers.dec();
      release();
    }
  }

  /** Pulls an image once even if many submissions need it at the same moment. */
  private ensureImage(image: string): Promise<void> {
    let pending = this.pulls.get(image);
    if (!pending) {
      pending = this.inspectOrPull(image).finally(() => this.pulls.delete(image));
      this.pulls.set(image, pending);
    }
    return pending;
  }

  private async inspectOrPull(image: string): Promise<void> {
    try {
      await docker.getImage(image).inspect();
      return;
    } catch (error) {
      // Only "no such image" means pull; anything else (daemon down) is an infrastructure failure.
      if ((error as { statusCode?: number }).statusCode !== 404) {
        throw new SandboxUnavailableError(`Docker is unavailable: ${(error as Error).message}`);
      }
    }

    logger.info({ image }, 'Pulling Docker image');
    try {
      await new Promise<void>((resolve, reject) => {
        docker.pull(image, (err: Error | null, stream: NodeJS.ReadableStream) => {
          if (err) return reject(err);
          docker.modem.followProgress(stream, (followErr: Error | null) => (followErr ? reject(followErr) : resolve()));
        });
      });
    } catch (error) {
      throw new SandboxUnavailableError(`Could not pull ${image}: ${(error as Error).message}`);
    }
  }

  /** Removes containers a previous run of this process left behind (for example after a crash mid-test). */
  private async removeOrphanedContainers(): Promise<void> {
    const orphans = await docker.listContainers({
      all: true,
      filters: { label: [`${LABEL_SANDBOX}=true`, `${LABEL_OWNER}=${this.ownerId}`] }
    });
    await Promise.all(orphans.map((info) => docker.getContainer(info.Id).remove({ force: true }).catch(() => {})));
    if (orphans.length > 0) {
      logger.warn({ count: orphans.length, ownerId: this.ownerId }, 'Removed orphaned sandbox containers');
    }
  }

  // Get circuit breaker status for monitoring
  getCircuitBreakerStatus(): { status: string; stats?: Record<string, number> } {
    if (!this.circuitBreaker) {
      return { status: 'not_initialized' };
    }

    const breaker = this.circuitBreaker;
    return {
      status: breaker.opened ? 'open' : breaker.halfOpen ? 'half_open' : 'closed',
      stats: {
        fires: breaker.stats.fires,
        successes: breaker.stats.successes,
        failures: breaker.stats.failures,
        rejects: breaker.stats.rejects,
        timeouts: breaker.stats.timeouts
      }
    };
  }
}

export default new CodeExecutor();
