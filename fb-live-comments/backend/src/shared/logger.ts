/**
 * Structured Logging Module
 *
 * Provides structured JSON logging using pino for consistent, machine-parseable logs.
 * In development, uses pino-pretty for human-readable output.
 * In production, outputs raw JSON for log aggregation systems.
 *
 * @module shared/logger
 */

import pino from 'pino';

const isProduction = process.env.NODE_ENV === 'production';

/**
 * Logger instance configured for the application environment.
 *
 * Development: Pretty-printed, colorized output
 * Production: JSON format for log aggregation (ELK, Splunk, etc.)
 */
export const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  base: {
    service: 'fb-live-comments',
    pid: process.pid,
  },
  timestamp: pino.stdTimeFunctions.isoTime,
  formatters: {
    level: (label) => ({ level: label }),
  },
  transport: isProduction
    ? undefined
    : {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'SYS:standard',
          ignore: 'pid,hostname',
        },
      },
});

/**
 * Creates a child logger with additional context.
 * Useful for adding request IDs, user IDs, or stream IDs to all logs in a scope.
 *
 * @param bindings - Key-value pairs to add to all log entries
 * @returns Child logger instance
 *
 * @example
 * const reqLogger = createChildLogger({ requestId: 'abc123', userId: 'user456' });
 * reqLogger.info('Processing request');
 * // Output: { ..., requestId: 'abc123', userId: 'user456', msg: 'Processing request' }
 */
export function createChildLogger(bindings: Record<string, unknown>): pino.Logger {
  return logger.child(bindings);
}

export default logger;
