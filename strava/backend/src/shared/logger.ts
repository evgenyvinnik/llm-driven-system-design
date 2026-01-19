/**
 * Structured JSON logging with pino for Strava fitness tracking platform
 *
 * Provides:
 * - Structured JSON logs for easy parsing by log aggregators
 * - Context-aware logging (request ID, user ID, etc.)
 * - Log levels: trace, debug, info, warn, error, fatal
 * - Performance-optimized logging with pino
 */
import pino, { Logger, LoggerOptions } from 'pino';
import crypto from 'crypto';
import { Request, Response, NextFunction } from 'express';

// Determine log level from environment
const LOG_LEVEL = process.env.LOG_LEVEL || (process.env.NODE_ENV === 'production' ? 'info' : 'debug');

// Base logger configuration
const loggerConfig: LoggerOptions = {
  level: LOG_LEVEL,
  base: {
    service: 'strava-backend',
    version: process.env.npm_package_version || '1.0.0',
    env: process.env.NODE_ENV || 'development'
  },
  timestamp: pino.stdTimeFunctions.isoTime,
  formatters: {
    level: (label: string) => ({ level: label })
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
export const logger: Logger = pino(transport ? { ...loggerConfig, transport } : loggerConfig);

/**
 * Create a child logger with additional context
 */
export function createLogger(context: Record<string, unknown>): Logger {
  return logger.child(context);
}

/**
 * Generate a unique request ID
 */
export function generateRequestId(): string {
  return crypto.randomBytes(8).toString('hex');
}

export interface RequestWithLog extends Request {
  requestId?: string;
  log?: Logger;
}

/**
 * Express middleware for request logging
 * Adds request ID and logs request/response
 */
export function requestLoggerMiddleware(req: RequestWithLog, res: Response, next: NextFunction): void {
  // Generate or use existing request ID
  const requestId = (req.headers['x-request-id'] as string) || generateRequestId();
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
      req.log!.error(logData, 'Request completed with server error');
    } else if (res.statusCode >= 400) {
      req.log!.warn(logData, 'Request completed with client error');
    } else {
      req.log!.info(logData, 'Request completed');
    }
  });

  next();
}

/**
 * Log activity-specific events
 */
export const activityLogger: Logger = createLogger({ component: 'activity' });

/**
 * Log segment-specific events
 */
export const segmentLogger: Logger = createLogger({ component: 'segment' });

/**
 * Log leaderboard-specific events
 */
export const leaderboardLogger: Logger = createLogger({ component: 'leaderboard' });

/**
 * Log feed-specific events
 */
export const feedLogger: Logger = createLogger({ component: 'feed' });

/**
 * Log database-specific events
 */
export const dbLogger: Logger = createLogger({ component: 'database' });

/**
 * Log Redis-specific events
 */
export const redisLogger: Logger = createLogger({ component: 'redis' });

/**
 * Log authentication events
 */
export const authLogger: Logger = createLogger({ component: 'auth' });

/**
 * Log data lifecycle events (archival, retention)
 */
export const lifecycleLogger: Logger = createLogger({ component: 'lifecycle' });

export interface ErrorWithCode extends Error {
  code?: string;
}

/**
 * Structured error logging helper
 */
export function logError(
  log: Logger,
  error: ErrorWithCode,
  message: string = 'An error occurred',
  context: Record<string, unknown> = {}
): void {
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
export function logGpsSync(
  log: Logger,
  activityId: string,
  status: string,
  details: Record<string, unknown> = {}
): void {
  log.info({
    activityId,
    gpsSync: {
      status,
      ...details
    }
  }, `GPS sync ${status}`);
}

export interface SegmentMatchResult {
  matched: boolean;
  [key: string]: unknown;
}

/**
 * Log segment matching events
 */
export function logSegmentMatch(
  log: Logger,
  activityId: string,
  segmentId: string,
  result: SegmentMatchResult
): void {
  log.info({
    activityId,
    segmentId,
    match: result
  }, result.matched ? 'Segment matched' : 'Segment not matched');
}

export interface LeaderboardUpdateResult {
  isPR: boolean;
  rank: number | null;
  elapsedTime: number;
}

/**
 * Log leaderboard update events
 */
export function logLeaderboardUpdate(
  log: Logger,
  userId: string,
  segmentId: string,
  result: LeaderboardUpdateResult
): void {
  log.info({
    userId,
    segmentId,
    isPR: result.isPR,
    rank: result.rank,
    elapsedTime: result.elapsedTime
  }, result.isPR ? 'New personal record' : 'Leaderboard position unchanged');
}

export default logger;
