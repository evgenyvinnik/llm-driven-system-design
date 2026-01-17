/**
 * Structured JSON logging using pino.
 * Provides consistent log format across all services for observability.
 * Includes trace context propagation for distributed tracing.
 */

import pino from 'pino';

/**
 * Logger configuration based on environment.
 * Development uses pretty printing, production uses JSON.
 */
const isDevelopment = process.env.NODE_ENV !== 'production';

/**
 * Main logger instance for the application.
 * Logs are structured as JSON for easy parsing by log aggregators.
 */
export const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  base: {
    service: process.env.SERVICE_NAME || 'google-docs-backend',
    server: `server-${process.env.PORT || '3001'}`,
  },
  timestamp: pino.stdTimeFunctions.isoTime,
  formatters: {
    level: (label) => ({ level: label }),
  },
  ...(isDevelopment
    ? {
        transport: {
          target: 'pino-pretty',
          options: {
            colorize: true,
            translateTime: 'SYS:standard',
            ignore: 'pid,hostname',
          },
        },
      }
    : {}),
});

/**
 * Creates a child logger with additional context.
 * Useful for adding request-specific data like trace_id, user_id, doc_id.
 *
 * @param context - Additional fields to include in all log entries
 * @returns Child logger instance with context
 */
export function createChildLogger(context: Record<string, unknown>): pino.Logger {
  return logger.child(context);
}

/**
 * Log levels for different scenarios:
 * - trace: Detailed debugging (cursor positions, every keystroke)
 * - debug: Development debugging (OT transforms, cache hits)
 * - info: Normal operations (document opened, user joined)
 * - warn: Recoverable issues (cache miss, slow query)
 * - error: Errors requiring attention (db failure, auth failure)
 * - fatal: Application cannot continue
 */

export default logger;
