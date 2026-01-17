/**
 * @fileoverview Structured JSON logging using pino.
 *
 * Provides a centralized logger for the rate limiter service with:
 * - Structured JSON output for log aggregation systems
 * - Request context tracking
 * - Environment-aware log levels
 * - Pretty printing in development mode
 */

import pino from 'pino';

/**
 * Environment-aware log level configuration.
 * - production: Only log errors and warnings for performance
 * - development: Log debug messages for troubleshooting
 * - test: Silence logs to avoid noise in test output
 */
const logLevel = process.env.LOG_LEVEL || (
  process.env.NODE_ENV === 'production' ? 'info' :
  process.env.NODE_ENV === 'test' ? 'silent' : 'debug'
);

/**
 * Pino transport configuration.
 * Uses pino-pretty for human-readable output in development.
 */
const transport = process.env.NODE_ENV !== 'production' ? {
  target: 'pino-pretty',
  options: {
    colorize: true,
    translateTime: 'SYS:standard',
    ignore: 'pid,hostname',
  },
} : undefined;

/**
 * Main logger instance for the rate limiter service.
 * All modules should import and use this logger for consistent formatting.
 *
 * @example
 * ```ts
 * import { logger } from '../shared/logger.js';
 *
 * logger.info({ identifier: 'api_key_123', allowed: true }, 'Rate limit check');
 * logger.error({ error: err.message }, 'Redis connection failed');
 * ```
 */
export const logger = pino({
  name: 'rate-limiter',
  level: logLevel,
  transport,
  base: {
    service: 'rate-limiter',
    version: process.env.npm_package_version || '1.0.0',
  },
  // Redact sensitive fields from logs
  redact: {
    paths: ['req.headers.authorization', 'req.headers["x-api-key"]'],
    censor: '[REDACTED]',
  },
  // Custom serializers for common objects
  serializers: {
    error: pino.stdSerializers.err,
    req: (req) => ({
      method: req.method,
      url: req.url,
      path: req.path,
      ip: req.ip,
    }),
    res: (res) => ({
      statusCode: res.statusCode,
    }),
  },
});

/**
 * Create a child logger with additional context.
 * Useful for adding request-specific information or component context.
 *
 * @param bindings - Additional fields to include in all log messages
 * @returns Child logger instance with the specified context
 *
 * @example
 * ```ts
 * const reqLogger = createChildLogger({ requestId: 'abc-123', userId: 'user_456' });
 * reqLogger.info('Processing request');
 * ```
 */
export function createChildLogger(bindings: Record<string, unknown>) {
  return logger.child(bindings);
}

/**
 * Log levels available for filtering.
 * Exported for configuration purposes.
 */
export type LogLevel = 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent';
