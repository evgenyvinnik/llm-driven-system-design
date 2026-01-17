/**
 * Structured JSON logging using pino.
 * Provides consistent log format across all services with request correlation.
 * Log levels: error, warn, info, debug (debug disabled in production).
 */
import pino from 'pino';

const isDevelopment = process.env.NODE_ENV === 'development';

/**
 * Application logger instance.
 * Configured with pretty printing in development and JSON in production.
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
  formatters: {
    level: (label) => ({ level: label }),
  },
  timestamp: pino.stdTimeFunctions.isoTime,
  base: {
    service: 'bitly-api',
    server_id: process.env.SERVER_ID || `server-${process.pid}`,
  },
});

/**
 * Creates a child logger with additional context.
 * Useful for adding request-specific fields like request ID.
 * @param context - Key-value pairs to include in all log entries
 * @returns Child logger with bound context
 */
export function createChildLogger(context: Record<string, unknown>) {
  return logger.child(context);
}

export default logger;
