/**
 * Structured logging module using pino.
 * Provides consistent JSON logging with configurable log levels.
 * All log entries include timestamp, level, and structured context.
 *
 * WHY: Structured logging enables log aggregation, filtering, and analysis
 * in production. JSON format integrates with log management systems like
 * ELK Stack, Datadog, or CloudWatch.
 *
 * @module shared/logger
 */

import pino from 'pino';

/**
 * Main application logger instance.
 * Configure via LOG_LEVEL environment variable (default: 'info').
 * Levels: fatal, error, warn, info, debug, trace
 */
export const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  formatters: {
    level: (label) => ({ level: label }),
  },
  // Add service name to all log entries for multi-service environments
  base: {
    service: 'google-sheets',
    pid: process.pid,
  },
  // Pretty printing in development
  ...(process.env.NODE_ENV !== 'production' && {
    transport: {
      target: 'pino-pretty',
      options: {
        colorize: true,
        translateTime: 'SYS:standard',
        ignore: 'pid,hostname',
      },
    },
  }),
});

/**
 * Creates a child logger with additional context.
 * Use for request-scoped or component-scoped logging.
 *
 * @example
 * const wsLogger = createChildLogger({ component: 'websocket' });
 * wsLogger.info({ spreadsheetId: 'abc' }, 'User connected');
 *
 * @param context - Additional fields to include in all child log entries
 * @returns A child logger instance with the provided context
 */
export function createChildLogger(context: Record<string, unknown>) {
  return logger.child(context);
}

/**
 * Log levels explained for this application:
 *
 * ERROR: Database failures, WebSocket errors, formula crashes
 * WARN: Cache misses on hot paths, slow queries (>100ms), reconnection failures
 * INFO: User join/leave, spreadsheet create/delete, export requests
 * DEBUG: Individual cell edits (sampled), cache operations
 */
export default logger;
