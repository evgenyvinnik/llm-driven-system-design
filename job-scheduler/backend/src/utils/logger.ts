/**
 * Logger module providing structured JSON logging for the job scheduler.
 * Uses Pino for high-performance, low-overhead structured logging.
 * In development, logs are pretty-printed; in production, they are JSON lines.
 * @module utils/logger
 */

import pino, { Logger } from 'pino';

/** Log level from environment, defaults to 'info' */
const logLevel = process.env.LOG_LEVEL || 'info';

/** Whether we are in development mode */
const isDevelopment = process.env.NODE_ENV !== 'production';

/**
 * Pino logger instance configured for the job scheduler.
 * Includes timestamp, service metadata, and error serialization.
 * Uses pino-pretty in development for human-readable output.
 */
export const logger: Logger = pino({
  level: logLevel,
  base: {
    service: process.env.SERVICE_NAME || 'job-scheduler',
    instance: process.env.WORKER_ID || process.env.SCHEDULER_INSTANCE_ID || 'unknown',
  },
  timestamp: pino.stdTimeFunctions.isoTime,
  formatters: {
    level: (label) => ({ level: label }),
    bindings: (bindings) => ({
      service: bindings.service,
      instance: bindings.instance,
      pid: bindings.pid,
      hostname: bindings.hostname,
    }),
  },
  serializers: {
    err: pino.stdSerializers.err,
    error: pino.stdSerializers.err,
    req: pino.stdSerializers.req,
    res: pino.stdSerializers.res,
  },
  transport: isDevelopment
    ? {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'SYS:standard',
          ignore: 'pid,hostname',
        },
      }
    : undefined,
});

/**
 * Creates a child logger with additional context.
 * Useful for adding request-specific or job-specific metadata.
 * @param bindings - Additional context to include in all log entries
 * @returns Child logger instance
 */
export function createChildLogger(bindings: Record<string, unknown>): Logger {
  return logger.child(bindings);
}

/**
 * Log levels available for structured logging.
 */
export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';

/**
 * Structured log entry interface for consistent logging.
 */
export interface LogEntry {
  message: string;
  level: LogLevel;
  timestamp: string;
  service: string;
  instance: string;
  [key: string]: unknown;
}
