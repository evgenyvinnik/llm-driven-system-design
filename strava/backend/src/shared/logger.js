/**
 * Structured JSON logging with pino for Strava fitness tracking platform
 *
 * Provides:
 * - Structured JSON logs for easy parsing by log aggregators
 * - Context-aware logging (request ID, user ID, etc.)
 * - Log levels: trace, debug, info, warn, error, fatal
 * - Performance-optimized logging with pino
 */
import pino from 'pino';
import crypto from 'crypto';

// Determine log level from environment
const LOG_LEVEL = process.env.LOG_LEVEL || (process.env.NODE_ENV === 'production' ? 'info' : 'debug');

// Base logger configuration
const loggerConfig = {
  level: LOG_LEVEL,
  base: {
    service: 'strava-backend',
    version: process.env.npm_package_version || '1.0.0',
    env: process.env.NODE_ENV || 'development'
  },
  timestamp: pino.stdTimeFunctions.isoTime,
  formatters: {
    level: (label) => ({ level: label })
  },
  // Redact sensitive fields
  redact: {
    paths: [
      'password',
      'password_hash',
      'passwordHash',
      'sessionId',
      'cookie',
      'authorization',
      'req.headers.cookie',
      'req.headers.authorization'
    ],
    censor: '[REDACTED]'
  }
};

// Use pretty print in development
const transport = process.env.NODE_ENV !== 'production'
  ? {
      target: 'pino-pretty',
      options: {
        colorize: true,
        translateTime: 'SYS:standard',
        ignore: 'pid,hostname'
      }
    }
  : undefined;

// Create the base logger
export const logger = pino(transport ? { ...loggerConfig, transport } : loggerConfig);

/**
 * Create a child logger with additional context
 */
export function createLogger(context) {
  return logger.child(context);
}

/**
 * Generate a unique request ID
 */
export function generateRequestId() {
  return crypto.randomBytes(8).toString('hex');
}

/**
 * Express middleware for request logging
 * Adds request ID and logs request/response
 */
export function requestLoggerMiddleware(req, res, next) {
  // Generate or use existing request ID
  const requestId = req.headers['x-request-id'] || generateRequestId();
  req.requestId = requestId;

  // Create request-scoped logger
  req.log = logger.child({
    requestId,
    method: req.method,
    path: req.path,
    userAgent: req.headers['user-agent']
  });

  // Add request ID to response headers
  res.setHeader('X-Request-Id', requestId);

  const start = process.hrtime.bigint();

  // Log request start
  req.log.debug({ query: req.query }, 'Request received');

  // Log response on finish
  res.on('finish', () => {
    const duration = Number(process.hrtime.bigint() - start) / 1e6; // ms

    const logData = {
      statusCode: res.statusCode,
      duration: `${duration.toFixed(2)}ms`,
      contentLength: res.getHeader('content-length')
    };

    if (res.statusCode >= 500) {
      req.log.error(logData, 'Request completed with server error');
    } else if (res.statusCode >= 400) {
      req.log.warn(logData, 'Request completed with client error');
    } else {
      req.log.info(logData, 'Request completed');
    }
  });

  next();
}

/**
 * Log activity-specific events
 */
export const activityLogger = createLogger({ component: 'activity' });

/**
 * Log segment-specific events
 */
export const segmentLogger = createLogger({ component: 'segment' });

/**
 * Log leaderboard-specific events
 */
export const leaderboardLogger = createLogger({ component: 'leaderboard' });

/**
 * Log feed-specific events
 */
export const feedLogger = createLogger({ component: 'feed' });

/**
 * Log database-specific events
 */
export const dbLogger = createLogger({ component: 'database' });

/**
 * Log Redis-specific events
 */
export const redisLogger = createLogger({ component: 'redis' });

/**
 * Log authentication events
 */
export const authLogger = createLogger({ component: 'auth' });

/**
 * Log data lifecycle events (archival, retention)
 */
export const lifecycleLogger = createLogger({ component: 'lifecycle' });

/**
 * Structured error logging helper
 */
export function logError(log, error, message = 'An error occurred', context = {}) {
  const errorData = {
    ...context,
    error: {
      name: error.name,
      message: error.message,
      stack: process.env.NODE_ENV !== 'production' ? error.stack : undefined,
      code: error.code
    }
  };

  log.error(errorData, message);
}

/**
 * Log GPS sync events for reliability tracking
 */
export function logGpsSync(log, activityId, status, details = {}) {
  log.info({
    activityId,
    gpsSync: {
      status,
      ...details
    }
  }, `GPS sync ${status}`);
}

/**
 * Log segment matching events
 */
export function logSegmentMatch(log, activityId, segmentId, result) {
  log.info({
    activityId,
    segmentId,
    match: result
  }, result.matched ? 'Segment matched' : 'Segment not matched');
}

/**
 * Log leaderboard update events
 */
export function logLeaderboardUpdate(log, userId, segmentId, result) {
  log.info({
    userId,
    segmentId,
    isPR: result.isPR,
    rank: result.rank,
    elapsedTime: result.elapsedTime
  }, result.isPR ? 'New personal record' : 'Leaderboard position unchanged');
}

export default logger;
