import pino from 'pino';
import { v4 as uuidv4 } from 'uuid';

/**
 * Structured JSON logging with pino
 *
 * Features:
 * - JSON output for production (machine-parseable for log aggregation)
 * - Pretty output for development
 * - Request ID tracking for distributed tracing
 * - Child loggers for service-specific context
 */

const isProd = process.env.NODE_ENV === 'production';

// Base logger configuration
const logger = pino({
  level: process.env.LOG_LEVEL || (isProd ? 'info' : 'debug'),
  formatters: {
    level: (label) => ({ level: label }),
  },
  base: {
    service: 'github-api',
    version: process.env.APP_VERSION || 'dev',
    pid: process.pid,
  },
  timestamp: pino.stdTimeFunctions.isoTime,
  // Use pino-pretty for development
  transport: isProd ? undefined : {
    target: 'pino-pretty',
    options: {
      colorize: true,
      translateTime: 'SYS:standard',
      ignore: 'pid,hostname',
    },
  },
});

/**
 * Create a child logger for a specific service
 * @param {string} serviceName
 */
export function createServiceLogger(serviceName) {
  return logger.child({ service: serviceName });
}

/**
 * Express middleware for request logging
 * Adds a unique request ID and logs request start/finish
 */
export function requestLoggerMiddleware(req, res, next) {
  const requestId = req.headers['x-request-id'] || uuidv4();
  const startTime = Date.now();

  // Create child logger with request context
  req.log = logger.child({
    requestId,
    method: req.method,
    path: req.path,
    ip: req.ip || req.connection?.remoteAddress,
    userAgent: req.headers['user-agent'],
  });

  // Add request ID to response headers for tracing
  res.setHeader('X-Request-Id', requestId);

  // Log request completion on response finish
  res.on('finish', () => {
    const duration = Date.now() - startTime;
    const logData = {
      statusCode: res.statusCode,
      durationMs: duration,
      userId: req.user?.id,
      contentLength: res.get('Content-Length'),
    };

    if (res.statusCode >= 500) {
      req.log.error(logData, 'request completed with error');
    } else if (res.statusCode >= 400) {
      req.log.warn(logData, 'request completed with client error');
    } else {
      req.log.info(logData, 'request completed');
    }
  });

  next();
}

/**
 * Log git operations with structured context
 */
export function logGitOperation(operation, owner, repo, details = {}) {
  logger.info({
    type: 'git_operation',
    operation,
    owner,
    repo,
    ...details,
  }, `git ${operation}`);
}

/**
 * Log cache operations
 */
export function logCacheOperation(operation, key, hit = null) {
  logger.debug({
    type: 'cache_operation',
    operation,
    key,
    hit,
  }, `cache ${operation}${hit !== null ? (hit ? ' hit' : ' miss') : ''}`);
}

export default logger;
