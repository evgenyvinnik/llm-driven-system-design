/**
 * Structured logging with pino.
 * Provides JSON-formatted logs for production observability
 * and human-readable output for development.
 * @module shared/logger
 */

import pino from 'pino';

/**
 * Determine if we're in development mode.
 * Uses pino-pretty transport for readable local development logs.
 */
const isDevelopment = process.env.NODE_ENV !== 'production';

/**
 * Application logger instance.
 * Configured for structured JSON logging in production
 * and pretty-printed output in development.
 */
export const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  formatters: {
    level: (label) => ({ level: label }),
    bindings: (bindings) => ({
      pid: bindings.pid,
      hostname: bindings.hostname,
      service: 'news-aggregator',
    }),
  },
  timestamp: pino.stdTimeFunctions.isoTime,
  ...(isDevelopment && {
    transport: {
      target: 'pino-pretty',
      options: {
        colorize: true,
        translateTime: 'HH:MM:ss',
        ignore: 'pid,hostname',
      },
    },
  }),
});

/**
 * Create a child logger with additional context.
 * Use this to add request-scoped context like traceId or userId.
 * @param context - Additional context to include in all log messages
 * @returns Child logger instance
 */
export function createChildLogger(context: Record<string, unknown>): pino.Logger {
  return logger.child(context);
}

/**
 * Express middleware for request logging.
 * Logs request method, path, status, and duration.
 */
export function requestLoggerMiddleware() {
  return (
    req: { method: string; path: string; headers: Record<string, string | string[] | undefined> },
    res: { statusCode: number; on: (event: string, cb: () => void) => void },
    next: () => void
  ) => {
    const start = Date.now();
    const traceId = (req.headers['x-trace-id'] as string) || crypto.randomUUID();

    res.on('finish', () => {
      const duration = Date.now() - start;
      logger.info({
        traceId,
        method: req.method,
        path: req.path,
        status: res.statusCode,
        durationMs: duration,
      }, 'Request completed');
    });

    next();
  };
}

export default logger;
