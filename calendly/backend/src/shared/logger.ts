import pino from 'pino';

/**
 * Application-wide structured JSON logger using pino.
 * Provides consistent logging format across all services.
 *
 * Log levels:
 * - trace: Detailed debugging (disabled in production)
 * - debug: Debug information for development
 * - info: General operational messages
 * - warn: Warning conditions that should be addressed
 * - error: Error conditions
 * - fatal: Critical errors that cause shutdown
 */
export const logger = pino({
  level: process.env.LOG_LEVEL || (process.env.NODE_ENV === 'production' ? 'info' : 'debug'),
  formatters: {
    level: (label) => ({ level: label }),
    bindings: (bindings) => ({
      pid: bindings.pid,
      host: bindings.hostname,
      service: 'calendly-api',
    }),
  },
  timestamp: pino.stdTimeFunctions.isoTime,
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'password',
      'password_hash',
      'access_token',
      'refresh_token',
    ],
    remove: true,
  },
});

/**
 * Creates a child logger with additional context.
 * Use for scoping logs to specific operations or requests.
 * @param context - Additional fields to include in all log entries
 * @returns Child logger instance
 */
export function createChildLogger(context: Record<string, unknown>) {
  return logger.child(context);
}

/**
 * Request context logger factory.
 * Creates loggers with request ID and user context for tracing.
 * @param requestId - Unique request identifier
 * @param userId - Optional authenticated user ID
 * @returns Child logger with request context
 */
export function createRequestLogger(requestId: string, userId?: string) {
  return logger.child({
    requestId,
    ...(userId && { userId }),
  });
}

export default logger;
