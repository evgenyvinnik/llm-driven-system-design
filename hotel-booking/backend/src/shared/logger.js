/**
 * Structured JSON logging with pino
 *
 * WHY: Structured logging enables:
 * - Machine-parseable logs for log aggregation systems
 * - Correlation via traceId across distributed services
 * - Consistent log format for alerting and debugging
 * - Sensitive data redaction (emails, payment info)
 */

const pino = require('pino');
const config = require('../config');

// Redact sensitive fields
const redactPaths = [
  'password',
  'passwordHash',
  'credit_card',
  'creditCard',
  'cardNumber',
  'cvv',
  '*.password',
  '*.passwordHash',
  'req.headers.authorization',
  'req.headers.cookie',
];

const logger = pino({
  level: config.nodeEnv === 'development' ? 'debug' : 'info',
  redact: redactPaths,
  base: {
    service: 'hotel-booking-api',
    version: process.env.npm_package_version || '1.0.0',
  },
  timestamp: pino.stdTimeFunctions.isoTime,
  formatters: {
    level: (label) => ({ level: label }),
  },
  transport:
    config.nodeEnv === 'development'
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
 * Create a child logger with request context
 * @param {Object} context - Request context (traceId, userId, etc.)
 * @returns {pino.Logger} Child logger with context
 */
function createRequestLogger(context = {}) {
  return logger.child(context);
}

/**
 * Extract trace ID from request or generate one
 * @param {Object} req - Express request object
 * @returns {string} Trace ID
 */
function getTraceId(req) {
  return (
    req.headers['x-request-id'] ||
    req.headers['x-trace-id'] ||
    require('crypto').randomUUID()
  );
}

/**
 * Express middleware for request logging
 */
function requestLoggerMiddleware(req, res, next) {
  const traceId = getTraceId(req);
  const startTime = Date.now();

  // Attach trace ID to request
  req.traceId = traceId;

  // Create request-scoped logger
  req.log = createRequestLogger({
    traceId,
    method: req.method,
    path: req.path,
  });

  // Log request start
  req.log.info({ query: req.query }, 'Request started');

  // Log response on finish
  res.on('finish', () => {
    const durationMs = Date.now() - startTime;
    const logData = {
      statusCode: res.statusCode,
      durationMs,
    };

    if (res.statusCode >= 500) {
      req.log.error(logData, 'Request failed');
    } else if (res.statusCode >= 400) {
      req.log.warn(logData, 'Request completed with client error');
    } else {
      req.log.info(logData, 'Request completed');
    }
  });

  // Set trace ID in response header for debugging
  res.setHeader('X-Request-ID', traceId);

  next();
}

module.exports = {
  logger,
  createRequestLogger,
  getTraceId,
  requestLoggerMiddleware,
};
