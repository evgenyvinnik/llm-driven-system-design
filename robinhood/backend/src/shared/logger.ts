/**
 * Structured JSON logging with pino.
 * Provides consistent, parseable log output for observability and debugging.
 * All log entries include timestamps, levels, and structured context.
 */

import pino from 'pino';
import { config } from '../config.js';

/**
 * Main application logger.
 * Uses pino for high-performance JSON logging with support for:
 * - Structured context (request IDs, user IDs, order IDs)
 * - Log levels (trace, debug, info, warn, error, fatal)
 * - Correlation IDs for distributed tracing
 */
export const logger = pino({
  name: 'robinhood-backend',
  level: process.env.LOG_LEVEL || 'info',
  transport:
    process.env.NODE_ENV === 'development'
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
    service: 'robinhood-backend',
    port: config.port,
  },
  serializers: {
    err: pino.stdSerializers.err,
    req: pino.stdSerializers.req,
    res: pino.stdSerializers.res,
  },
});

/**
 * Creates a child logger with additional context.
 * Use for request-scoped or component-scoped logging.
 * @param context - Key-value pairs to include in all log entries
 * @returns Child logger with context
 */
export function createChildLogger(context: Record<string, unknown>): pino.Logger {
  return logger.child(context);
}

/**
 * Log context for request tracing.
 */
export interface LogContext {
  requestId?: string;
  userId?: string;
  orderId?: string;
  symbol?: string;
  action?: string;
}

/**
 * Creates a logger with request context.
 * @param ctx - Request context
 * @returns Child logger with request context
 */
export function withContext(ctx: LogContext): pino.Logger {
  return logger.child(ctx);
}
