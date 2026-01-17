/**
 * Structured JSON Logger using Pino.
 *
 * Provides structured logging with automatic request context, log levels,
 * and JSON output for production environments. Key benefits:
 *
 * - Structured JSON output enables log aggregation (ELK, Datadog, etc.)
 * - Request context (requestId, accountId, profileId) for tracing
 * - Automatic performance timing
 * - Level-based filtering (debug, info, warn, error)
 */
import pino from 'pino';
import pinoHttp from 'pino-http';

/**
 * Base logger instance configured for the current environment.
 * Uses pretty printing in development, JSON in production.
 */
export const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  transport:
    process.env.NODE_ENV !== 'production'
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
    service: 'netflix-api',
    version: process.env.npm_package_version || '1.0.0',
  },
  formatters: {
    level: (label) => ({ level: label }),
  },
  timestamp: pino.stdTimeFunctions.isoTime,
});

/**
 * HTTP request logging middleware.
 * Automatically logs incoming requests and responses with timing.
 * Attaches a unique request ID for distributed tracing.
 */
export const httpLogger = pinoHttp({
  logger,
  // Generate unique request ID
  genReqId: (req) => {
    return (req.headers['x-request-id'] as string) || crypto.randomUUID();
  },
  // Custom request serializer - redact sensitive data
  serializers: {
    req: (req) => ({
      method: req.method,
      url: req.url,
      headers: {
        'user-agent': req.headers['user-agent'],
        'content-type': req.headers['content-type'],
        'x-request-id': req.headers['x-request-id'],
      },
    }),
    res: (res) => ({
      statusCode: res.statusCode,
    }),
  },
  // Custom log message
  customLogLevel: (_req, res, err) => {
    if (res.statusCode >= 500 || err) {
      return 'error';
    } else if (res.statusCode >= 400) {
      return 'warn';
    }
    return 'info';
  },
  // Don't log health check requests
  autoLogging: {
    ignore: (req) => {
      return req.url === '/health' || req.url === '/metrics';
    },
  },
});

/**
 * Creates a child logger with additional context.
 * Useful for adding request-specific context that persists across log calls.
 *
 * @param context - Additional context to include in all log entries
 * @returns Child logger instance with context
 *
 * @example
 * const reqLogger = createChildLogger({ requestId: '123', accountId: 'abc' });
 * reqLogger.info('Processing request');
 * // Output: { requestId: '123', accountId: 'abc', msg: 'Processing request' }
 */
export function createChildLogger(context: Record<string, unknown>) {
  return logger.child(context);
}

/**
 * Logs streaming-specific events for analytics and debugging.
 * Includes video/episode context and quality information.
 */
export const streamingLogger = logger.child({ component: 'streaming' });

/**
 * Logs authentication and authorization events.
 * Useful for security auditing and debugging access issues.
 */
export const authLogger = logger.child({ component: 'auth' });

/**
 * Logs circuit breaker state changes and failures.
 * Critical for monitoring external service dependencies.
 */
export const circuitBreakerLogger = logger.child({ component: 'circuit-breaker' });

/**
 * Logs database query performance and errors.
 */
export const dbLogger = logger.child({ component: 'database' });

/**
 * Logs background job execution.
 */
export const jobLogger = logger.child({ component: 'jobs' });

export default logger;
