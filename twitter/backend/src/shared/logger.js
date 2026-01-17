import pino from 'pino';
import dotenv from 'dotenv';

dotenv.config();

const isProduction = process.env.NODE_ENV === 'production';

/**
 * Structured JSON logger using Pino
 *
 * In production: JSON output for log aggregation (ELK, Datadog, etc.)
 * In development: Pretty-printed human-readable output
 */
const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  // Add common fields to all log entries
  base: {
    service: 'twitter-api',
    version: process.env.npm_package_version || '1.0.0',
    env: process.env.NODE_ENV || 'development',
  },
  // Timestamp format
  timestamp: pino.stdTimeFunctions.isoTime,
  // Redact sensitive fields
  redact: {
    paths: ['req.headers.authorization', 'req.headers.cookie', 'password', 'passwordHash'],
    censor: '[REDACTED]',
  },
  // Pretty print in development
  transport: isProduction
    ? undefined
    : {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'SYS:standard',
          ignore: 'pid,hostname',
        },
      },
});

/**
 * Create a child logger with request context
 * @param {object} context - Additional context fields (requestId, userId, etc.)
 * @returns {pino.Logger}
 */
export function createRequestLogger(context) {
  return logger.child(context);
}

/**
 * Express middleware for request logging
 */
export function requestLoggerMiddleware(req, res, next) {
  const startTime = Date.now();
  const requestId = req.headers['x-request-id'] || crypto.randomUUID();

  // Attach request ID to request object
  req.requestId = requestId;

  // Create child logger with request context
  req.log = logger.child({
    requestId,
    method: req.method,
    path: req.path,
    userAgent: req.headers['user-agent'],
  });

  // Log request start
  req.log.info({ type: 'request_start' }, `${req.method} ${req.path}`);

  // Log response when finished
  res.on('finish', () => {
    const duration = Date.now() - startTime;
    const logData = {
      type: 'request_complete',
      statusCode: res.statusCode,
      durationMs: duration,
      userId: req.session?.userId,
    };

    if (res.statusCode >= 500) {
      req.log.error(logData, `${req.method} ${req.path} - ${res.statusCode}`);
    } else if (res.statusCode >= 400) {
      req.log.warn(logData, `${req.method} ${req.path} - ${res.statusCode}`);
    } else {
      req.log.info(logData, `${req.method} ${req.path} - ${res.statusCode}`);
    }
  });

  next();
}

export default logger;
