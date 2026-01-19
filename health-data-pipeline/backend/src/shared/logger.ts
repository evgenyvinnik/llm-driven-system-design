import pino from 'pino';
import { config } from '../config/index.js';

/**
 * Structured logging with pino.
 *
 * WHY: Structured logging enables machine-parseable logs for:
 * - Centralized log aggregation (ELK, Datadog, etc.)
 * - Correlation via request IDs across services
 * - Efficient filtering and alerting on specific fields
 * - Performance - pino is one of the fastest Node.js loggers
 */

const logLevel = config.nodeEnv === 'production' ? 'info' : 'debug';

// Base logger configuration
const loggerOptions = {
  level: logLevel,
  // Redact sensitive fields from logs
  redact: {
    paths: ['req.headers.authorization', 'req.headers.cookie', 'password', 'token', 'sessionToken'],
    censor: '[REDACTED]'
  },
  // Add base fields to all log entries
  base: {
    service: 'health-data-pipeline',
    env: config.nodeEnv,
    version: process.env.npm_package_version || '1.0.0'
  },
  // Custom timestamp format
  timestamp: pino.stdTimeFunctions.isoTime,
  // Format error objects properly
  formatters: {
    level: (label) => ({ level: label }),
    bindings: (bindings) => ({
      pid: bindings.pid,
      host: bindings.hostname
    })
  }
};

// Use pretty printing in development
const transport = config.nodeEnv === 'development'
  ? {
      target: 'pino-pretty',
      options: {
        colorize: true,
        translateTime: 'SYS:standard',
        ignore: 'pid,hostname'
      }
    }
  : undefined;

export const logger = pino(
  loggerOptions,
  transport ? pino.transport(transport) : undefined
);

/**
 * Create a child logger with request context.
 * Enables request tracing across service calls.
 */
export function createRequestLogger(req) {
  const requestId = req.headers['x-request-id'] || crypto.randomUUID();

  return logger.child({
    requestId,
    method: req.method,
    url: req.url,
    userId: req.user?.id
  });
}

/**
 * Express middleware for request logging.
 * Logs request start and completion with timing.
 */
export function requestLoggingMiddleware(req, res, next) {
  const startTime = Date.now();
  const requestId = req.headers['x-request-id'] || crypto.randomUUID();

  // Attach request ID for downstream use
  req.requestId = requestId;
  res.setHeader('X-Request-ID', requestId);

  // Create child logger for this request
  req.log = logger.child({
    requestId,
    method: req.method,
    url: req.url
  });

  // Log request start
  req.log.info({ msg: 'Request started' });

  // Log response when finished
  res.on('finish', () => {
    const duration = Date.now() - startTime;
    const logData = {
      msg: 'Request completed',
      statusCode: res.statusCode,
      durationMs: duration,
      userId: req.user?.id
    };

    // Use different log levels based on status code
    if (res.statusCode >= 500) {
      req.log.error(logData);
    } else if (res.statusCode >= 400) {
      req.log.warn(logData);
    } else {
      req.log.info(logData);
    }
  });

  next();
}

/**
 * Log health data sync operations with sample counts and timing.
 */
export function logSyncOperation(userId, deviceId, result, durationMs) {
  logger.info({
    msg: 'Health data sync completed',
    operation: 'device_sync',
    userId,
    deviceId,
    samplesProcessed: result.synced,
    errorsCount: result.errors,
    durationMs
  });
}

/**
 * Log aggregation operations.
 */
export function logAggregation(userId, types, dateRange, durationMs) {
  logger.info({
    msg: 'Aggregation completed',
    operation: 'aggregation',
    userId,
    types,
    dateRange,
    durationMs
  });
}

/**
 * Log database operations for performance monitoring.
 */
export function logDbQuery(query, params, durationMs) {
  // Only log slow queries in production
  const threshold = config.nodeEnv === 'production' ? 100 : 500;

  if (durationMs > threshold) {
    logger.warn({
      msg: 'Slow query detected',
      operation: 'db_query',
      query: query.substring(0, 200), // Truncate long queries
      durationMs,
      threshold
    });
  }
}

export default logger;
