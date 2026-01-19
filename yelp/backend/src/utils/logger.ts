import pino from 'pino';

/**
 * Structured JSON logging with pino
 *
 * Log levels:
 * - error: Failures requiring attention (5xx, unhandled exceptions)
 * - warn: Degraded behavior (retries, cache misses, rate limits)
 * - info: Request/response, major state changes
 * - debug: Detailed debugging (disabled in production)
 */

const isProduction = process.env.NODE_ENV === 'production';

export const logger = pino({
  level: process.env.LOG_LEVEL || (isProduction ? 'info' : 'debug'),

  // Format options
  formatters: {
    level: (label) => ({ level: label }),
    bindings: (bindings) => ({
      service: 'yelp-api',
      pid: bindings.pid,
      hostname: bindings.hostname,
    }),
  },

  // Timestamp format
  timestamp: pino.stdTimeFunctions.isoTime,

  // Redact sensitive fields from logs
  redact: {
    paths: [
      'password',
      'password_hash',
      'authorization',
      'cookie',
      'session_token',
      'req.headers.authorization',
      'req.headers.cookie',
    ],
    censor: '[REDACTED]',
  },

  // Base context included in all logs
  base: {
    service: 'yelp-api',
    version: process.env.npm_package_version || '1.0.0',
  },

  // Pretty print in development
  ...(isProduction ? {} : {
    transport: {
      target: 'pino-pretty',
      options: {
        colorize: true,
        translateTime: 'SYS:standard',
        ignore: 'pid,hostname',
      },
    },
  }),
});

/**
 * Create a child logger with request context
 * @param {object} context - Additional context (requestId, userId, etc.)
 * @returns {pino.Logger}
 */
export function createRequestLogger(context = {}) {
  return logger.child(context);
}

/**
 * Log HTTP request with standard fields
 * @param {object} req - Express request object
 * @param {object} res - Express response object
 * @param {number} duration - Request duration in ms
 * @param {object} extra - Additional fields to log
 */
export function logRequest(req, res, duration, extra = {}) {
  const logData = {
    method: req.method,
    path: req.path,
    status: res.statusCode,
    duration_ms: duration,
    ip: req.ip || req.connection?.remoteAddress,
    userAgent: req.get('user-agent'),
    ...extra,
  };

  if (req.user) {
    logData.userId = req.user.id;
    logData.userRole = req.user.role;
  }

  if (req.requestId) {
    logData.requestId = req.requestId;
  }

  if (res.statusCode >= 500) {
    logger.error(logData, 'Request failed');
  } else if (res.statusCode >= 400) {
    logger.warn(logData, 'Request error');
  } else {
    logger.info(logData, 'Request completed');
  }
}

/**
 * Log database operation
 * @param {string} operation - Query type (SELECT, INSERT, etc.)
 * @param {string} table - Table name
 * @param {number} duration - Query duration in ms
 * @param {object} extra - Additional fields
 */
export function logDbOperation(operation, table, duration, extra = {}) {
  logger.debug({
    component: 'database',
    operation,
    table,
    duration_ms: duration,
    ...extra,
  }, 'Database operation');
}

/**
 * Log cache operation
 * @param {string} operation - Cache operation (get, set, del)
 * @param {string} key - Cache key
 * @param {boolean} hit - Whether cache hit occurred
 * @param {object} extra - Additional fields
 */
export function logCacheOperation(operation, key, hit, extra = {}) {
  logger.debug({
    component: 'cache',
    operation,
    key,
    hit,
    ...extra,
  }, `Cache ${operation}`);
}

/**
 * Log search operation
 * @param {string} query - Search query
 * @param {number} resultCount - Number of results
 * @param {number} duration - Search duration in ms
 * @param {object} extra - Additional fields (cache_hit, filters, etc.)
 */
export function logSearch(query, resultCount, duration, extra = {}) {
  logger.info({
    component: 'search',
    query,
    resultCount,
    duration_ms: duration,
    ...extra,
  }, 'Search executed');
}

/**
 * Log circuit breaker events
 * @param {string} name - Circuit breaker name
 * @param {string} state - New state (OPEN, CLOSED, HALF_OPEN)
 * @param {object} extra - Additional context
 */
export function logCircuitBreaker(name, state, extra = {}) {
  const logLevel = state === 'OPEN' ? 'warn' : 'info';
  logger[logLevel]({
    component: 'circuit_breaker',
    name,
    state,
    ...extra,
  }, `Circuit breaker ${name} is ${state}`);
}

export default logger;
