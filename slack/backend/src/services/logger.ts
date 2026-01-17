/**
 * @fileoverview Structured JSON logging service using pino.
 * Provides a configured logger instance for consistent logging across the application.
 * Supports different log levels based on environment and includes request context.
 */

import pino from 'pino';
import dotenv from 'dotenv';

dotenv.config();

const isProduction = process.env.NODE_ENV === 'production';

/**
 * Configured pino logger instance.
 * In development, uses pino-pretty for human-readable output.
 * In production, outputs structured JSON for log aggregation systems.
 */
export const logger = pino({
  level: process.env.LOG_LEVEL || (isProduction ? 'info' : 'debug'),
  formatters: {
    level: (label) => ({ level: label }),
  },
  timestamp: pino.stdTimeFunctions.isoTime,
  base: {
    service: 'slack-backend',
    version: process.env.npm_package_version || '1.0.0',
    env: process.env.NODE_ENV || 'development',
  },
  transport: isProduction
    ? undefined
    : {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'SYS:standard',
          ignore: 'pid,hostname,service,version,env',
        },
      },
});

/**
 * Creates a child logger with additional context.
 * Use this to add request-scoped or module-scoped context to logs.
 * @param bindings - Additional context to include in all logs from this child
 * @returns Child logger instance with the specified bindings
 */
export function createChildLogger(bindings: Record<string, unknown>): pino.Logger {
  return logger.child(bindings);
}

/**
 * Creates a request-scoped logger with request ID and user context.
 * @param requestId - Unique identifier for the request
 * @param userId - Authenticated user ID (if available)
 * @param workspaceId - Current workspace context (if available)
 * @returns Child logger with request context
 */
export function createRequestLogger(
  requestId: string,
  userId?: string,
  workspaceId?: string
): pino.Logger {
  return logger.child({
    requestId,
    ...(userId && { userId }),
    ...(workspaceId && { workspaceId }),
  });
}

export default logger;
