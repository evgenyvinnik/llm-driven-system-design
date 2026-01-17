/**
 * Structured JSON logging with pino.
 * Provides consistent log format across all services for better observability.
 *
 * Features:
 * - JSON output for machine parsing
 * - Request correlation IDs
 * - Log levels configurable via LOG_LEVEL env var
 * - Pretty printing in development mode
 *
 * @module shared/logger
 */
import pino from 'pino';

const isDevelopment = process.env.NODE_ENV !== 'production';

/**
 * Application logger instance.
 * Uses pino for high-performance structured logging.
 */
export const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
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
  base: {
    service: 'local-delivery',
    version: process.env.npm_package_version || '1.0.0',
  },
});

/**
 * Creates a child logger with additional context.
 * Use this to add service-specific or request-specific context.
 *
 * @param context - Additional context to include in all log messages
 * @returns A child logger with the provided context
 *
 * @example
 * const orderLogger = createChildLogger({ service: 'orders' });
 * orderLogger.info({ orderId: '123' }, 'Order created');
 */
export function createChildLogger(context: Record<string, unknown>) {
  return logger.child(context);
}

/**
 * Order service logger.
 */
export const orderLogger = createChildLogger({ module: 'orders' });

/**
 * Driver service logger.
 */
export const driverLogger = createChildLogger({ module: 'drivers' });

/**
 * Matching service logger.
 */
export const matchingLogger = createChildLogger({ module: 'matching' });

/**
 * Auth service logger.
 */
export const authLogger = createChildLogger({ module: 'auth' });

export default logger;
