/**
 * Job handler registry and built-in handlers.
 * Handlers are functions that execute job logic based on the job's handler field.
 * Custom handlers can be registered at startup for application-specific jobs.
 * @module worker/handlers
 */

import { Job, JobExecution } from '../types';
import { logger } from '../utils/logger';
import * as db from '../db/repository';

/**
 * Job handler function signature.
 * @param job - The job being executed
 * @param execution - The execution record
 * @param context - Execution context with logging and worker info
 * @returns Promise resolving to the handler result
 */
type JobHandler = (
  job: Job,
  execution: JobExecution,
  context: ExecutionContext
) => Promise<unknown>;

/**
 * Execution context provided to handlers.
 * Contains utilities for logging and accessing worker information.
 */
export interface ExecutionContext {
  /** Logs a message to the execution log */
  log: (level: 'info' | 'warn' | 'error', message: string, metadata?: Record<string, unknown>) => Promise<void>;
  /** ID of the worker executing this job */
  workerId: string;
}

/** Registry mapping handler names to their implementations */
const handlers: Map<string, JobHandler> = new Map();

/**
 * Registers a job handler with the given name.
 * Handlers must be registered before jobs using them can be executed.
 * @param name - Unique handler name (e.g., 'http.webhook')
 * @param handler - Handler function to execute
 */
export function registerHandler(name: string, handler: JobHandler): void {
  handlers.set(name, handler);
  logger.info(`Registered handler: ${name}`);
}

/**
 * Retrieves a registered handler by name.
 * @param name - Handler name to look up
 * @returns The handler function or undefined if not found
 */
export function getHandler(name: string): JobHandler | undefined {
  return handlers.get(name);
}

/**
 * Checks if a handler with the given name is registered.
 * @param name - Handler name to check
 * @returns True if the handler exists
 */
export function hasHandler(name: string): boolean {
  return handlers.has(name);
}

/**
 * Lists all registered handler names.
 * Useful for debugging and API endpoints.
 * @returns Array of registered handler names
 */
export function listHandlers(): string[] {
  return Array.from(handlers.keys());
}

// === Built-in Handlers ===

/**
 * HTTP webhook handler - makes HTTP requests to external services.
 * Payload should include: url, method (optional), headers (optional), timeout (optional).
 */
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

/**
 * Shell command handler - executes shell commands for local automation.
 * Payload should include: command, args (optional), cwd (optional), env (optional).
 * Use with caution in production environments.
 */
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

/**
 * Test delay handler - simulates work with configurable delay.
 * Payload: durationMs (optional), shouldFail (optional), failMessage (optional).
 * Useful for testing retry logic and monitoring.
 */
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

/**
 * Test echo handler - returns the job payload as the result.
 * Useful for testing job creation and execution flow.
 */
// Echo handler (for testing)
registerHandler('test.echo', async (job, execution, context) => {
  await context.log('info', 'Echoing payload');
  return job.payload;
});

/**
 * Test log handler - logs a message at the specified level.
 * Payload: message (optional), level (optional: 'info' | 'warn' | 'error').
 */
// Log handler (for testing)
registerHandler('test.log', async (job, execution, context) => {
  const { message = 'Test log message', level = 'info' } = job.payload as {
    message?: string;
    level?: 'info' | 'warn' | 'error';
  };

  await context.log(level, message, { payload: job.payload });

  return { logged: true, message };
});

/**
 * System cleanup handler - removes old execution records.
 * Payload: olderThanDays (optional, default: 30).
 * Currently logs what would be deleted but doesn't perform actual deletion for safety.
 */
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
