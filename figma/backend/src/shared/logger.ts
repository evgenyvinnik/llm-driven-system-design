/**
 * Structured JSON logging with pino.
 * Provides consistent log formatting across all services.
 * Log level is configurable via LOG_LEVEL environment variable.
 */
import pino from 'pino';

const logLevel = process.env.LOG_LEVEL || 'info';

/**
 * Main application logger instance.
 * Configured with JSON output for production log aggregation.
 */
export const logger = pino({
  level: logLevel,
  transport: process.env.NODE_ENV === 'development'
    ? {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'SYS:standard',
          ignore: 'pid,hostname',
        },
      }
    : undefined,
  base: {
    pid: process.pid,
    service: 'figma-backend',
  },
  timestamp: pino.stdTimeFunctions.isoTime,
});

/**
 * Creates a child logger with additional context.
 * Useful for adding request-specific or component-specific metadata.
 * @param context - Object with additional context to include in logs
 * @returns Child logger instance with merged context
 */
export function createChildLogger(context: Record<string, unknown>) {
  return logger.child(context);
}

/**
 * Log levels for reference:
 * - fatal (60): Application crashes, unrecoverable errors
 * - error (50): Unhandled exceptions, database failures, critical errors
 * - warn (40): Circuit breaker state changes, retry attempts, deprecation warnings
 * - info (30): Connection events, file subscriptions, request handling
 * - debug (20): Individual operations, SQL queries, detailed flow
 * - trace (10): Very detailed debugging information
 */
export default logger;
