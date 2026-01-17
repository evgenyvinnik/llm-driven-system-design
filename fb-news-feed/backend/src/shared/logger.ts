/**
 * @fileoverview Structured JSON logging with pino.
 * Provides consistent logging format across all services with contextual metadata.
 * Supports request ID propagation for distributed tracing.
 */

import pino from 'pino';

/**
 * Base logger configuration for production and development.
 * In production, outputs JSON for log aggregation.
 * In development, uses pino-pretty for human-readable output.
 */
const isDev = process.env.NODE_ENV !== 'production';

/**
 * Main application logger instance.
 * Use this for application-level logging.
 */
export const logger = pino({
  level: process.env.LOG_LEVEL || (isDev ? 'debug' : 'info'),
  formatters: {
    level: (label) => ({ level: label }),
  },
  timestamp: pino.stdTimeFunctions.isoTime,
  base: {
    service: 'fb-news-feed',
    pid: process.pid,
    environment: process.env.NODE_ENV || 'development',
  },
  transport: isDev
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
 * Useful for adding request ID, user ID, or component-specific fields.
 *
 * @param context - Additional fields to include in all log entries
 * @returns Child logger instance with merged context
 */
export function createChildLogger(context: Record<string, unknown>) {
  return logger.child(context);
}

/**
 * Creates a request-scoped logger with request ID and optional user info.
 * Should be used in middleware to create a logger for each request.
 *
 * @param requestId - Unique identifier for the request
 * @param userId - Optional authenticated user ID
 * @returns Child logger with request context
 */
export function createRequestLogger(requestId: string, userId?: string) {
  return logger.child({
    requestId,
    ...(userId && { userId }),
  });
}

/**
 * Pre-configured loggers for specific components.
 * Adds component-specific context to all log entries.
 */
export const componentLoggers = {
  auth: logger.child({ component: 'auth' }),
  feed: logger.child({ component: 'feed' }),
  posts: logger.child({ component: 'posts' }),
  fanout: logger.child({ component: 'fanout' }),
  db: logger.child({ component: 'database' }),
  cache: logger.child({ component: 'cache' }),
  ws: logger.child({ component: 'websocket' }),
};

export default logger;
