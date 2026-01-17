import pino from 'pino';
import { config } from './index.js';

/**
 * Structured JSON logger using pino.
 * Provides consistent logging format across all services with
 * appropriate log levels based on environment.
 *
 * Features:
 * - JSON output for production (machine-readable)
 * - Pretty printing for development (human-readable)
 * - Request correlation via child loggers
 * - Automatic timestamp and level fields
 */
export const logger = pino({
  level: config.nodeEnv === 'production' ? 'info' : 'debug',
  ...(config.nodeEnv === 'development'
    ? {
        transport: {
          target: 'pino-pretty',
          options: {
            colorize: true,
            translateTime: 'SYS:standard',
          },
        },
      }
    : {}),
  base: {
    service: 'jira-backend',
    env: config.nodeEnv,
  },
  formatters: {
    level: (label) => ({ level: label }),
  },
  timestamp: pino.stdTimeFunctions.isoTime,
});

/**
 * Creates a child logger with additional context.
 * Used to add request-specific or operation-specific context.
 *
 * @param context - Additional context to include in all log entries
 * @returns Child logger instance
 */
export function createChildLogger(context: Record<string, unknown>) {
  return logger.child(context);
}

/**
 * Log levels for different operation types.
 */
export const logLevels = {
  debug: 'debug',
  info: 'info',
  warn: 'warn',
  error: 'error',
  fatal: 'fatal',
} as const;

export default logger;
