/**
 * Structured JSON logging module using pino.
 * Provides consistent logging across all services with request correlation,
 * error serialization, and development-friendly pretty printing.
 * @module shared/logger
 */

import pino from 'pino'
import { _Request, _Response, _NextFunction } from 'express'

/**
 * Log level from environment or default to 'info'.
 * Levels: trace, debug, info, warn, error, fatal
 */
const LOG_LEVEL = process.env.LOG_LEVEL || 'info'

/**
 * Whether to use pretty printing (development mode).
 * In production, use structured JSON for log aggregation.
 */
const PRETTY_PRINT = process.env.NODE_ENV !== 'production'

/**
 * Service name for log context.
 * Each service should set this via environment variable.
 */
const SERVICE_NAME = process.env.SERVICE_NAME || 'scale-ai'

/**
 * Base pino logger instance with structured JSON output.
 * Includes timestamp, service name, and error serialization.
 */
export const logger = pino({
  level: LOG_LEVEL,
  base: {
    service: SERVICE_NAME,
    pid: process.pid,
  },
  timestamp: pino.stdTimeFunctions.isoTime,
  formatters: {
    level: (label) => ({ level: label }),
  },
  ...(PRETTY_PRINT && {
    transport: {
      target: 'pino-pretty',
      options: {
        colorize: true,
        translateTime: 'SYS:standard',
        ignore: 'pid,hostname',
      },
    },
  }),
})

/**
 * Creates a child logger with additional context.
 * Useful for adding request IDs or module-specific context.
 *
 * @param context - Object with additional context to include in all logs
 * @returns Child logger with merged context
 *
 * @example
 * ```typescript
 * const reqLogger = createChildLogger({ requestId: 'abc-123', userId: 'user-456' })
 * reqLogger.info('Processing request')
 * // Output: {"level":"info","requestId":"abc-123","userId":"user-456","msg":"Processing request"}
 * ```
 */
export function createChildLogger(context: Record<string, unknown>): pino.Logger {
  return logger.child(context)
}

/**
 * Generates a unique request ID for correlation.
 * Uses a combination of timestamp and random string.
 *
 * @returns Unique request ID string
 */
function generateRequestId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).substring(2, 9)}`
}

/**
 * Logs an error with stack trace and additional context.
 * Properly serializes Error objects for structured logging.
 *
 * @param err - Error object to log
 * @param context - Additional context for the error
 */
export function logError(err: Error, context?: Record<string, unknown>): void {
  logger.error({
    err: {
      type: err.name,
      message: err.message,
      stack: err.stack,
    },
    ...context,
  })
}

export default logger
