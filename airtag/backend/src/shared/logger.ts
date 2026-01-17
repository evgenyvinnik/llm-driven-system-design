import pino from 'pino';
import pinoHttp from 'pino-http';
import { Request, Response } from 'express';

/**
 * Structured logger using Pino for high-performance JSON logging.
 *
 * WHY PINO:
 * - 5x faster than Winston/Bunyan due to low overhead async logging
 * - Native JSON output for structured logging (machine-parseable)
 * - Built-in log levels with numeric comparison for filtering
 * - Child loggers for request-scoped context without memory overhead
 *
 * STRUCTURED LOGGING BENEFITS:
 * - Enables log aggregation in ELK/Splunk/CloudWatch
 * - Allows correlation of requests across microservices via request IDs
 * - Supports alerting on specific error types or latency thresholds
 * - Provides audit trail for security and compliance
 */

const logLevel = process.env.LOG_LEVEL || (process.env.NODE_ENV === 'production' ? 'info' : 'debug');

/**
 * Base logger instance.
 * Use logger.child({ component: 'name' }) to create component-specific loggers.
 */
export const logger = pino({
  level: logLevel,
  // Add service metadata to every log entry
  base: {
    service: 'findmy-backend',
    version: process.env.npm_package_version || '1.0.0',
  },
  // Format timestamps as ISO strings for human readability and parsing
  timestamp: pino.stdTimeFunctions.isoTime,
  // Pretty print in development for easier debugging
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
});

/**
 * HTTP request logging middleware.
 * Automatically logs request/response pairs with timing, status codes, and context.
 *
 * LOG FIELDS:
 * - req.id: Unique request ID for correlation
 * - req.method: HTTP method
 * - req.url: Request URL (path + query)
 * - res.statusCode: HTTP response status
 * - responseTime: Time to complete request in ms
 *
 * PRIVACY: Sensitive fields (authorization, cookies) are redacted.
 */
export const httpLogger = pinoHttp({
  logger,
  // Generate unique request IDs for correlation
  genReqId: (req: Request) =>
    (req.headers['x-request-id'] as string) || crypto.randomUUID(),

  // Customize log level based on response status
  customLogLevel: (req: Request, res: Response, err?: Error) => {
    if (res.statusCode >= 500 || err) return 'error';
    if (res.statusCode >= 400) return 'warn';
    return 'info';
  },

  // Redact sensitive headers for security
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'req.headers["x-api-key"]',
    ],
    censor: '[REDACTED]',
  },

  // Add custom attributes to log entries
  customAttributeKeys: {
    req: 'request',
    res: 'response',
    err: 'error',
    responseTime: 'duration_ms',
  },

  // Skip health check logging to reduce noise
  autoLogging: {
    ignore: (req: Request) => req.url === '/health' || req.url === '/metrics',
  },
});

/**
 * Create a child logger for a specific component.
 * Child loggers inherit parent config but add component-specific context.
 *
 * @param component - The name of the component (e.g., 'locationService', 'auth')
 * @returns A child logger with component context
 *
 * @example
 * const log = createComponentLogger('locationService');
 * log.info({ deviceId }, 'Processing location report');
 */
export function createComponentLogger(component: string) {
  return logger.child({ component });
}

/**
 * Log an operation with timing information.
 * Useful for measuring database queries, external API calls, etc.
 *
 * @param operationName - Name of the operation being timed
 * @param fn - Async function to execute and time
 * @returns The result of the function
 *
 * @example
 * const result = await logTimed('db.getDevices', async () => {
 *   return pool.query('SELECT * FROM devices');
 * });
 */
export async function logTimed<T>(
  operationName: string,
  fn: () => Promise<T>
): Promise<T> {
  const start = performance.now();
  try {
    const result = await fn();
    const duration = performance.now() - start;
    logger.debug({ operation: operationName, duration_ms: duration }, 'Operation completed');
    return result;
  } catch (error) {
    const duration = performance.now() - start;
    logger.error(
      { operation: operationName, duration_ms: duration, error },
      'Operation failed'
    );
    throw error;
  }
}

export default logger;
