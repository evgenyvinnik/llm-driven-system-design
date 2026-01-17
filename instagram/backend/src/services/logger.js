import pino from 'pino';
import config from '../config/index.js';

/**
 * Structured JSON logger using pino
 *
 * Provides consistent logging format across all services with:
 * - Request ID tracking for distributed tracing
 * - User context when available
 * - Performance timing
 * - Error stack traces
 */
const logger = pino({
  level: config.nodeEnv === 'production' ? 'info' : 'debug',
  formatters: {
    level: (label) => ({ level: label }),
  },
  timestamp: () => `,"timestamp":"${new Date().toISOString()}"`,
  base: {
    service: 'instagram-api',
    env: config.nodeEnv,
    port: config.port,
  },
  // In production, use default JSON output
  // In development, use pretty printing
  transport:
    config.nodeEnv !== 'production'
      ? {
          target: 'pino/file',
          options: { destination: 1 }, // stdout
        }
      : undefined,
});

/**
 * Create a child logger with request context
 * @param {Object} req - Express request object
 * @returns {Object} Child logger with request context
 */
export const createRequestLogger = (req) => {
  return logger.child({
    requestId: req.traceId,
    method: req.method,
    path: req.path,
    userId: req.session?.userId,
    username: req.session?.username,
  });
};

/**
 * Log request completion with timing
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @param {number} duration - Request duration in ms
 */
export const logRequest = (req, res, duration) => {
  const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info';

  logger[level]({
    requestId: req.traceId,
    method: req.method,
    path: req.originalUrl,
    status: res.statusCode,
    durationMs: duration,
    userId: req.session?.userId,
    contentLength: res.get('content-length'),
    userAgent: req.get('user-agent'),
  }, `${req.method} ${req.originalUrl} ${res.statusCode} ${duration}ms`);
};

/**
 * Log an error with full context
 * @param {Error} error - Error object
 * @param {Object} context - Additional context
 */
export const logError = (error, context = {}) => {
  logger.error({
    error: error.name || 'Error',
    message: error.message,
    stack: error.stack,
    ...context,
  }, error.message);
};

/**
 * Log a database query with timing
 * @param {string} queryName - Name/description of the query
 * @param {number} duration - Query duration in ms
 * @param {Object} context - Additional context
 */
export const logQuery = (queryName, duration, context = {}) => {
  const level = duration > 1000 ? 'warn' : 'debug';
  logger[level]({
    type: 'db_query',
    query: queryName,
    durationMs: duration,
    ...context,
  }, `DB: ${queryName} (${duration}ms)`);
};

/**
 * Log a cache operation
 * @param {string} operation - Cache operation (get, set, del)
 * @param {string} key - Cache key
 * @param {boolean} hit - Whether it was a cache hit
 */
export const logCache = (operation, key, hit = null) => {
  logger.debug({
    type: 'cache',
    operation,
    key: key.substring(0, 50), // Truncate long keys
    hit,
  }, `Cache ${operation}: ${key.substring(0, 50)}${hit !== null ? (hit ? ' HIT' : ' MISS') : ''}`);
};

/**
 * Log a metrics event (for business metrics)
 * @param {string} event - Event name
 * @param {Object} data - Event data
 */
export const logMetric = (event, data = {}) => {
  logger.info({
    type: 'metric',
    event,
    ...data,
  }, `Metric: ${event}`);
};

export default logger;
