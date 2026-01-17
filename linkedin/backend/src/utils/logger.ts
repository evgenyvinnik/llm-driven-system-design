/**
 * Structured logging configuration using Pino.
 * Provides JSON-formatted logs with trace context for observability.
 *
 * @module utils/logger
 */
import pino from 'pino';

const isDevelopment = process.env.NODE_ENV !== 'production';

/**
 * Logger instance configured for the LinkedIn backend.
 * - Development: Pretty-printed output for readability
 * - Production: JSON format for log aggregation (ELK, Loki)
 */
export const logger = pino({
  level: process.env.LOG_LEVEL || (isDevelopment ? 'debug' : 'info'),
  transport: isDevelopment
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
    service: process.env.SERVICE_NAME || 'linkedin-api',
    version: process.env.npm_package_version || '1.0.0',
  },
  formatters: {
    level: (label) => ({ level: label }),
  },
  timestamp: () => `,"timestamp":"${new Date().toISOString()}"`,
});

/**
 * Creates a child logger with additional context.
 * Use this for request-scoped logging with trace IDs.
 *
 * @param context - Additional context to include in all log entries
 * @returns Child logger instance
 */
export function createChildLogger(context: Record<string, unknown>) {
  return logger.child(context);
}

/**
 * Log entry interface for structured logging.
 */
export interface LogContext {
  traceId?: string;
  spanId?: string;
  userId?: number;
  method?: string;
  path?: string;
  statusCode?: number;
  duration?: number;
  error?: {
    name: string;
    message: string;
    stack?: string;
  };
  [key: string]: unknown;
}

/**
 * Creates an error object for structured logging.
 * Extracts name, message, and stack trace from Error instances.
 *
 * @param error - The error to format
 * @returns Formatted error object for logging
 */
export function formatError(error: unknown): LogContext['error'] {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
    };
  }
  return {
    name: 'UnknownError',
    message: String(error),
  };
}

export default logger;
