/**
 * @fileoverview Centralized structured logging with pino.
 *
 * Provides a configured pino logger instance for use across all services.
 * Features:
 * - Structured JSON logging for production (easy parsing by log aggregators)
 * - Pretty printing for development (human-readable output)
 * - Configurable log levels via LOG_LEVEL environment variable
 * - Child loggers with context for request tracing
 */

import pino, { Logger } from 'pino';

/**
 * Determines if the application is running in production mode.
 */
const isProduction = process.env.NODE_ENV === 'production';

/**
 * Creates the base pino logger configuration.
 *
 * In production: JSON output for log aggregation (ELK, Datadog, etc.)
 * In development: Pretty-printed output for readability
 */
const logger: Logger = pino({
  level: process.env.LOG_LEVEL || (isProduction ? 'info' : 'debug'),
  // Base context included in all log entries
  base: {
    service: process.env.SERVICE_NAME || 'dashboarding-api',
    version: process.env.npm_package_version || '1.0.0',
  },
  // Timestamp format
  timestamp: pino.stdTimeFunctions.isoTime,
  // Pretty print for development
  transport: isProduction
    ? undefined
    : {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'HH:MM:ss.l',
          ignore: 'pid,hostname',
        },
      },
  // Redact sensitive fields from logs
  redact: {
    paths: ['req.headers.authorization', 'req.headers.cookie', 'password', 'password_hash'],
    censor: '[REDACTED]',
  },
});

/**
 * Creates a child logger with additional context.
 *
 * Useful for adding request-specific context (requestId, userId)
 * that will be included in all subsequent log entries.
 *
 * @param context - Additional context to include in log entries
 * @returns A child logger with the merged context
 *
 * @example
 * const reqLogger = createChildLogger({ requestId: 'abc123', userId: 42 });
 * reqLogger.info('Processing request'); // Includes requestId and userId
 */
export function createChildLogger(context: Record<string, unknown>): Logger {
  return logger.child(context);
}

/**
 * Logs application startup information.
 *
 * @param port - The port the server is listening on
 * @param environment - The current environment (development, production, etc.)
 */
export function logStartup(port: number, environment: string): void {
  logger.info(
    {
      port,
      environment,
      nodeVersion: process.version,
      pid: process.pid,
    },
    'Server started'
  );
}

/**
 * Logs application shutdown information.
 *
 * @param signal - The signal that triggered shutdown (SIGTERM, SIGINT, etc.)
 */
export function logShutdown(signal: string): void {
  logger.info({ signal }, 'Server shutting down');
}

export default logger;
