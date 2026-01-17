import { Job, JobExecution } from '../types';
import { logger } from '../utils/logger';
import * as db from '../db/repository';

// Job handler registry
type JobHandler = (
  job: Job,
  execution: JobExecution,
  context: ExecutionContext
) => Promise<unknown>;

export interface ExecutionContext {
  log: (level: 'info' | 'warn' | 'error', message: string, metadata?: Record<string, unknown>) => Promise<void>;
  workerId: string;
}

const handlers: Map<string, JobHandler> = new Map();

/**
 * Register a job handler
 */
export function registerHandler(name: string, handler: JobHandler): void {
  handlers.set(name, handler);
  logger.info(`Registered handler: ${name}`);
}

/**
 * Get a registered handler
 */
export function getHandler(name: string): JobHandler | undefined {
  return handlers.get(name);
}

/**
 * Check if a handler exists
 */
export function hasHandler(name: string): boolean {
  return handlers.has(name);
}

/**
 * List all registered handlers
 */
export function listHandlers(): string[] {
  return Array.from(handlers.keys());
}

// Register built-in handlers

// HTTP webhook handler
registerHandler('http.webhook', async (job, execution, context) => {
  const { url, method = 'POST', headers = {}, timeout = 30000 } = job.payload as {
    url: string;
    method?: string;
    headers?: Record<string, string>;
    timeout?: number;
  };

  await context.log('info', `Calling webhook: ${method} ${url}`);

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch(url, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'X-Job-ID': job.id,
        'X-Execution-ID': execution.id,
        ...headers,
      },
      body: method !== 'GET' ? JSON.stringify(job.payload) : undefined,
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    const responseBody = await response.text();

    if (!response.ok) {
      throw new Error(`Webhook returned ${response.status}: ${responseBody}`);
    }

    await context.log('info', `Webhook completed with status ${response.status}`);

    return {
      status: response.status,
      body: responseBody,
    };
  } catch (error) {
    clearTimeout(timeoutId);
    throw error;
  }
});

// Shell command handler (for local development/testing)
registerHandler('shell.command', async (job, execution, context) => {
  const { command, args = [], cwd, env = {} } = job.payload as {
    command: string;
    args?: string[];
    cwd?: string;
    env?: Record<string, string>;
  };

  await context.log('info', `Executing command: ${command} ${args.join(' ')}`);

  const { spawn } = await import('child_process');

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, ...env },
      shell: true,
    });

    let stdout = '';
    let stderr = '';

    child.stdout?.on('data', (data) => {
      stdout += data.toString();
    });

    child.stderr?.on('data', (data) => {
      stderr += data.toString();
    });

    child.on('close', async (code) => {
      if (code === 0) {
        await context.log('info', `Command completed successfully`);
        resolve({ exitCode: code, stdout, stderr });
      } else {
        await context.log('error', `Command failed with exit code ${code}`, { stderr });
        reject(new Error(`Command failed with exit code ${code}: ${stderr}`));
      }
    });

    child.on('error', (error) => {
      reject(error);
    });
  });
});

// Delay handler (for testing)
registerHandler('test.delay', async (job, execution, context) => {
  const { durationMs = 1000, shouldFail = false, failMessage = 'Simulated failure' } = job.payload as {
    durationMs?: number;
    shouldFail?: boolean;
    failMessage?: string;
  };

  await context.log('info', `Delaying for ${durationMs}ms`);

  await new Promise((resolve) => setTimeout(resolve, durationMs));

  if (shouldFail) {
    throw new Error(failMessage);
  }

  await context.log('info', 'Delay completed successfully');

  return { delayed: durationMs };
});

// Echo handler (for testing)
registerHandler('test.echo', async (job, execution, context) => {
  await context.log('info', 'Echoing payload');
  return job.payload;
});

// Log handler (for testing)
registerHandler('test.log', async (job, execution, context) => {
  const { message = 'Test log message', level = 'info' } = job.payload as {
    message?: string;
    level?: 'info' | 'warn' | 'error';
  };

  await context.log(level, message, { payload: job.payload });

  return { logged: true, message };
});

// Database cleanup handler
registerHandler('system.cleanup', async (job, execution, context) => {
  const { olderThanDays = 30 } = job.payload as { olderThanDays?: number };

  await context.log('info', `Cleaning up executions older than ${olderThanDays} days`);

  // This would delete old execution records
  // For safety, we'll just log what would be deleted
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - olderThanDays);

  await context.log('info', `Would clean up executions before ${cutoffDate.toISOString()}`);

  return { cutoffDate: cutoffDate.toISOString(), olderThanDays };
});
