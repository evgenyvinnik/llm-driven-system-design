import Docker from 'dockerode';
import { v4 as uuidv4 } from 'uuid';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import type CircuitBreaker from 'opossum';

import { createModuleLogger } from '../shared/logger.js';
import { metrics } from '../shared/metrics.js';
import { createExecutionCircuitBreaker, createFallback, type ExecutionOptions, type ExecutionResult } from '../shared/circuitBreaker.js';

const logger = createModuleLogger('code-executor');
const docker = new Docker();

interface LanguageConfig {
  image: string;
  extension: string;
  command: (file: string) => string[];
  timeout: number;
  memoryMb: number;
}

// Resource limits per language
const LANGUAGE_CONFIG: Record<string, LanguageConfig> = {
  python: {
    image: 'python:3.11-alpine',
    extension: '.py',
    command: (file: string) => ['python3', file],
    timeout: 10000,
    memoryMb: 256
  },
  javascript: {
    image: 'node:20-alpine',
    extension: '.js',
    command: (file: string) => ['node', file],
    timeout: 8000,
    memoryMb: 256
  }
};

interface CollectOutputResult {
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

class CodeExecutor {
  private tempDir: string;
  private circuitBreaker: CircuitBreaker<[ExecutionOptions], ExecutionResult> | null;

  constructor() {
    this.tempDir = path.join(os.tmpdir(), 'leetcode-sandbox');
    this.circuitBreaker = null;
  }

  async init(): Promise<void> {
    try {
      await fs.mkdir(this.tempDir, { recursive: true });
      logger.info({ tempDir: this.tempDir }, 'Code executor initialized');

      // Initialize circuit breaker wrapping the container execution
      this.circuitBreaker = createExecutionCircuitBreaker(
        this._runInContainerInternal.bind(this)
      );

      // Set up fallback for when circuit breaker is open
      this.circuitBreaker.fallback(createFallback());

    } catch (error) {
      logger.error({ error: (error as Error).message }, 'Failed to initialize code executor');
    }
  }

  async execute(code: string, language: string, input: string, timeLimit = 5000, memoryLimit = 256): Promise<ExecutionResult> {
    const config = LANGUAGE_CONFIG[language];
    if (!config) {
      return {
        status: 'system_error',
        error: `Unsupported language: ${language}`
      };
    }

    const executionId = uuidv4();
    const workDir = path.join(this.tempDir, executionId);
    const codeFile = `solution${config.extension}`;
    const codePath = path.join(workDir, codeFile);
    const inputPath = path.join(workDir, 'input.txt');

    try {
      // Create work directory
      await fs.mkdir(workDir, { recursive: true });

      // Write code and input files
      await fs.writeFile(codePath, code);
      await fs.writeFile(inputPath, input);

      const startTime = Date.now();

      // Track active container
      metrics.activeContainers.inc();

      // Execute in Docker container (through circuit breaker)
      const result = await this.runInContainer({
        image: config.image,
        workDir,
        codeFile,
        command: config.command(`/code/${codeFile}`),
        timeout: Math.min(timeLimit, config.timeout),
        memoryMb: Math.min(memoryLimit, config.memoryMb),
        language
      });

      const executionTime = Date.now() - startTime;

      // Record execution metrics
      metrics.codeExecutionsTotal.inc({
        status: result.status,
        language
      });

      metrics.codeExecutionDuration.observe(
        { language, status: result.status },
        executionTime / 1000
      );

      // Decrement active container count
      metrics.activeContainers.dec();

      logger.debug({
        executionId,
        language,
        status: result.status,
        executionTimeMs: executionTime
      }, 'Code execution completed');

      return {
        ...result,
        executionTime
      };
    } catch (error) {
      logger.error({
        error: (error as Error).message,
        executionId,
        language
      }, 'Execution error');

      // Decrement active container on error
      metrics.activeContainers.dec();

      // Record error metric
      metrics.codeExecutionsTotal.inc({
        status: 'system_error',
        language
      });

      return {
        status: 'system_error',
        error: (error as Error).message,
        executionTime: 0
      };
    } finally {
      // Cleanup
      try {
        await fs.rm(workDir, { recursive: true, force: true });
      } catch (e) {
        logger.warn({ error: (e as Error).message, workDir }, 'Cleanup error');
      }
    }
  }

  async runInContainer(options: ExecutionOptions): Promise<ExecutionResult> {
    // Use circuit breaker to protect against sandbox failures
    if (this.circuitBreaker) {
      try {
        return await this.circuitBreaker.fire(options);
      } catch (error) {
        // Circuit breaker is open or execution failed
        if ((error as { code?: string }).code === 'EOPENBREAKER') {
          return {
            status: 'system_error',
            error: 'Code execution temporarily unavailable. Please try again later.',
            isCircuitBreakerOpen: true
          };
        }
        throw error;
      }
    }

    // Fallback if circuit breaker not initialized
    return await this._runInContainerInternal(options);
  }

  async _runInContainerInternal({ image, workDir, command, timeout, memoryMb }: ExecutionOptions): Promise<ExecutionResult> {
    let container: Docker.Container | null = null;

    try {
      // Pull image if not exists (with timeout)
      try {
        await docker.getImage(image).inspect();
      } catch {
        logger.info({ image }, 'Pulling Docker image');
        await new Promise<void>((resolve, reject) => {
          docker.pull(image, (err: Error | null, stream: NodeJS.ReadableStream) => {
            if (err) return reject(err);
            docker.modem.followProgress(stream, (err: Error | null) => {
              if (err) return reject(err);
              resolve();
            });
          });
        });
      }

      // Create container with security restrictions
      container = await docker.createContainer({
        Image: image,
        Cmd: command,
        WorkingDir: '/code',
        HostConfig: {
          Binds: [`${workDir}:/code:ro`],
          Memory: memoryMb * 1024 * 1024,
          MemorySwap: memoryMb * 1024 * 1024, // No swap
          CpuPeriod: 100000,
          CpuQuota: 50000, // 50% of one CPU
          PidsLimit: 50,
          NetworkMode: 'none',
          ReadonlyRootfs: false,
          SecurityOpt: ['no-new-privileges'],
          CapDrop: ['ALL'],
          AutoRemove: true
        },
        OpenStdin: true,
        StdinOnce: true,
        AttachStdin: true,
        AttachStdout: true,
        AttachStderr: true,
        Tty: false
      });

      // Read input file
      const input = await fs.readFile(path.join(workDir, 'input.txt'), 'utf8');

      // Start container
      const stream = await container.attach({
        stream: true,
        stdin: true,
        stdout: true,
        stderr: true
      });

      await container.start();

      // Send input
      stream.write(input);
      stream.end();

      // Collect output with timeout
      const { stdout, stderr, timedOut } = await this.collectOutput(container, stream, timeout);

      if (timedOut) {
        logger.warn({ timeout }, 'Code execution timed out');
        return {
          status: 'time_limit_exceeded',
          stdout: stdout.substring(0, 1000),
          stderr: stderr.substring(0, 1000)
        };
      }

      // Wait for container to finish
      const waitResult = await container.wait();

      if (waitResult.StatusCode !== 0) {
        return {
          status: 'runtime_error',
          stdout: stdout.substring(0, 1000),
          stderr: stderr.substring(0, 1000),
          exitCode: waitResult.StatusCode
        };
      }

      return {
        status: 'success',
        stdout: stdout.trim(),
        stderr: stderr.substring(0, 1000)
      };
    } catch (error) {
      logger.error({ error: (error as Error).message }, 'Container error');

      // Check for OOM
      if ((error as Error).message && (error as Error).message.includes('OOMKilled')) {
        return {
          status: 'memory_limit_exceeded',
          error: 'Out of memory'
        };
      }

      // Re-throw for circuit breaker to track
      throw error;
    } finally {
      // Ensure container is stopped and removed
      if (container) {
        try {
          await container.stop({ t: 0 }).catch(() => {});
          await container.remove({ force: true }).catch(() => {});
        } catch {
          // Container might already be removed due to AutoRemove
        }
      }
    }
  }

  async collectOutput(container: Docker.Container, stream: NodeJS.ReadWriteStream, timeout: number): Promise<CollectOutputResult> {
    return new Promise((resolve) => {
      let stdout = '';
      const stderr = '';
      let timedOut = false;

      const timeoutId = setTimeout(async () => {
        timedOut = true;
        try {
          await container.stop({ t: 0 });
        } catch {
          // Ignore
        }
        resolve({ stdout, stderr, timedOut: true });
      }, timeout);

      // Docker multiplexed stream format
      stream.on('data', (chunk: Buffer) => {
        // First 8 bytes are header (stream type + size)
        // For simplicity, treat all as stdout
        const text = chunk.toString('utf8');
        // Remove Docker stream headers (non-printable chars at start)
        const cleaned = text.replace(/^[\x00-\x08]/g, '');
        stdout += cleaned;
      });

      container.wait().then(() => {
        clearTimeout(timeoutId);
        if (!timedOut) {
          resolve({ stdout, stderr, timedOut: false });
        }
      }).catch(() => {
        clearTimeout(timeoutId);
        if (!timedOut) {
          resolve({ stdout, stderr, timedOut: false });
        }
      });
    });
  }

  compareOutput(actual: string, expected: string): boolean {
    // Normalize whitespace
    const normalize = (s: string) => s.trim().replace(/\r\n/g, '\n').replace(/\s+$/gm, '');

    const actualNorm = normalize(actual);
    const expectedNorm = normalize(expected);

    if (actualNorm === expectedNorm) {
      return true;
    }

    // Try parsing as JSON for array comparison
    try {
      const actualJson = JSON.parse(actualNorm);
      const expectedJson = JSON.parse(expectedNorm);

      // For arrays, sort if order doesn't matter (for problems like Two Sum)
      if (Array.isArray(actualJson) && Array.isArray(expectedJson)) {
        // Try both sorted and unsorted comparison
        if (JSON.stringify(actualJson) === JSON.stringify(expectedJson)) {
          return true;
        }
        // Sort and compare for problems where order doesn't matter
        const sortedActual = [...actualJson].sort((a, b) => a - b);
        const sortedExpected = [...expectedJson].sort((a, b) => a - b);
        if (JSON.stringify(sortedActual) === JSON.stringify(sortedExpected)) {
          return true;
        }
      }
    } catch {
      // Not JSON, continue with string comparison
    }

    // Handle floating point comparison
    const actualNum = parseFloat(actualNorm);
    const expectedNum = parseFloat(expectedNorm);
    if (!isNaN(actualNum) && !isNaN(expectedNum)) {
      return Math.abs(actualNum - expectedNum) < 1e-6;
    }

    return false;
  }

  // Get circuit breaker status for monitoring
  getCircuitBreakerStatus(): { status: string; stats?: Record<string, number> } {
    if (!this.circuitBreaker) {
      return { status: 'not_initialized' };
    }

    return {
      status: this.circuitBreaker.status.name,
      stats: {
        fires: this.circuitBreaker.stats.fires,
        successes: this.circuitBreaker.stats.successes,
        failures: this.circuitBreaker.stats.failures,
        rejects: this.circuitBreaker.stats.rejects,
        timeouts: this.circuitBreaker.stats.timeouts
      }
    };
  }
}

export default new CodeExecutor();
