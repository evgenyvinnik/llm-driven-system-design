/**
 * Structured JSON logging with pino
 * Provides consistent log format across all services
 */

import pino from 'pino';
import { SERVER_CONFIG } from './config.js';

// Create the base logger
const logger = pino({
  level: SERVER_CONFIG.logLevel,
  formatters: {
    level: (label) => {
      return { level: label };
    },
  },
  timestamp: pino.stdTimeFunctions.isoTime,
  base: {
    service: 'youtube-topk',
    env: SERVER_CONFIG.nodeEnv,
    pid: process.pid,
  },
  // Use pino-pretty in development for readable output
  transport:
    SERVER_CONFIG.nodeEnv === 'development'
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
 * Create a child logger with additional context
 * @param {object} bindings - Additional fields to include in all logs
 * @returns {pino.Logger} Child logger instance
 */
export function createLogger(bindings) {
  return logger.child(bindings);
}

/**
 * Request logger middleware for Express
 * Logs incoming requests with timing information
 */
export function requestLogger(req, res, next) {
  const startTime = Date.now();
  const requestId = req.headers['x-request-id'] || `req-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

  // Attach logger and requestId to request object
  req.log = logger.child({ requestId });
  req.requestId = requestId;

  // Log request start
  req.log.info(
    {
      type: 'request',
      method: req.method,
      path: req.path,
      query: req.query,
      userAgent: req.get('user-agent'),
      ip: req.ip || req.connection?.remoteAddress,
    },
    `Incoming ${req.method} ${req.path}`
  );

  // Override res.end to log response
  const originalEnd = res.end;
  res.end = function (...args) {
    const duration = Date.now() - startTime;

    req.log.info(
      {
        type: 'response',
        method: req.method,
        path: req.path,
        statusCode: res.statusCode,
        durationMs: duration,
      },
      `${req.method} ${req.path} ${res.statusCode} ${duration}ms`
    );

    originalEnd.apply(res, args);
  };

  next();
}

/**
 * Error logger helper
 * @param {Error} error - The error object
 * @param {object} context - Additional context
 */
export function logError(error, context = {}) {
  logger.error(
    {
      type: 'error',
      error: {
        message: error.message,
        name: error.name,
        stack: error.stack,
      },
      ...context,
    },
    error.message
  );
}

/**
 * Log view event for analytics
 * @param {string} videoId - The video ID
 * @param {string} category - The video category
 * @param {object} metadata - Additional metadata
 */
export function logViewEvent(videoId, category, metadata = {}) {
  logger.info(
    {
      type: 'view_event',
      videoId,
      category,
      ...metadata,
    },
    `View recorded for video ${videoId}`
  );
}

/**
 * Log trending calculation metrics
 * @param {string} category - The category
 * @param {number} videoCount - Number of trending videos
 * @param {number} durationMs - Calculation duration
 */
export function logTrendingCalculation(category, videoCount, durationMs) {
  logger.info(
    {
      type: 'trending_calculation',
      category,
      videoCount,
      durationMs,
    },
    `Trending calculated for ${category}: ${videoCount} videos in ${durationMs}ms`
  );
}

/**
 * Log heap operation for algorithm analysis
 * @param {string} operation - Operation type (push, pop, update)
 * @param {number} heapSize - Current heap size
 * @param {number} durationMicros - Operation duration in microseconds
 */
export function logHeapOperation(operation, heapSize, durationMicros) {
  logger.debug(
    {
      type: 'heap_operation',
      operation,
      heapSize,
      durationMicros,
    },
    `Heap ${operation}: size=${heapSize}, duration=${durationMicros}us`
  );
}

/**
 * Log cache hit/miss for monitoring cache effectiveness
 * @param {string} cacheType - Type of cache (trending, metadata)
 * @param {boolean} hit - Whether it was a cache hit
 * @param {string} key - Cache key
 */
export function logCacheAccess(cacheType, hit, key) {
  logger.debug(
    {
      type: 'cache_access',
      cacheType,
      hit,
      key,
    },
    `Cache ${hit ? 'HIT' : 'MISS'} for ${cacheType}:${key}`
  );
}

/**
 * Log alert when threshold is exceeded
 * @param {string} metric - The metric name
 * @param {number} value - Current value
 * @param {number} threshold - Threshold value
 * @param {string} severity - 'warning' or 'critical'
 */
export function logAlert(metric, value, threshold, severity) {
  const logFn = severity === 'critical' ? logger.error : logger.warn;
  logFn.call(
    logger,
    {
      type: 'alert',
      metric,
      value,
      threshold,
      severity,
    },
    `ALERT [${severity.toUpperCase()}]: ${metric} = ${value} (threshold: ${threshold})`
  );
}

/**
 * Log idempotency check result
 * @param {string} idempotencyKey - The idempotency key
 * @param {boolean} duplicate - Whether it was a duplicate
 */
export function logIdempotencyCheck(idempotencyKey, duplicate) {
  logger.debug(
    {
      type: 'idempotency_check',
      key: idempotencyKey,
      duplicate,
    },
    duplicate ? `Duplicate request detected: ${idempotencyKey}` : `New request: ${idempotencyKey}`
  );
}

export default logger;
