import pino, { Logger } from 'pino';
import { Request, Response, NextFunction } from 'express';

// ============ Type Definitions ============

interface RequestWithLog extends Request {
  log: Logger;
}

interface LogEventData {
  videoId?: string;
  userId?: string;
  fileSize?: number;
  filename?: string;
  duration?: number;
  resolutions?: string[];
  error?: string;
  username?: string;
  channelId?: string;
  service?: string;
  failures?: number;
  endpoint?: string;
  ip?: string;
  key?: string;
  watchDuration?: number;
}

// ============ Logger Setup ============

/**
 * Structured JSON logger using pino
 *
 * Log levels:
 * - ERROR: Failures requiring attention (transcode failures, DB errors)
 * - WARN: Degraded state (cache miss, rate limit hit, circuit breaker open)
 * - INFO: Business events (upload, publish, subscribe, view)
 * - DEBUG: Request/response details (development only)
 *
 * All logs include:
 * - timestamp: ISO 8601 format
 * - level: Log level
 * - requestId: Request correlation ID (when available)
 * - service: Service name
 */

const isDevelopment = process.env.NODE_ENV !== 'production';

// Create base logger
const logger: Logger = pino({
  level: process.env.LOG_LEVEL || (isDevelopment ? 'debug' : 'info'),
  transport: isDevelopment
    ? {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'SYS:standard',
          ignore: 'pid,hostname',
        },
      }
    : undefined,
  base: {
    service: 'youtube-api',
    pid: process.pid,
  },
  formatters: {
    level: (label: string) => ({ level: label }),
  },
  timestamp: pino.stdTimeFunctions.isoTime,
});

/**
 * Create a child logger with request context
 */
export const createChildLogger = (context: Record<string, unknown>): Logger => {
  return logger.child(context);
};

/**
 * Express middleware to attach request-scoped logger
 * Adds requestId and logs request/response
 */
export const requestLogger = (
  req: Request,
  res: Response,
  next: NextFunction
): void => {
  const reqWithLog = req as RequestWithLog;

  // Generate or use existing request ID
  const requestId =
    (req.headers['x-request-id'] as string | undefined) || crypto.randomUUID();

  // Create child logger with request context
  reqWithLog.log = logger.child({
    requestId,
    method: req.method,
    path: req.path,
    ip: req.ip,
  });

  // Set response header for tracing
  res.setHeader('X-Request-ID', requestId);

  // Log request start
  const startTime = Date.now();

  reqWithLog.log.info({ event: 'request_start' }, `${req.method} ${req.path}`);

  // Log response on finish
  res.on('finish', () => {
    const duration = Date.now() - startTime;
    const logData = {
      event: 'request_end',
      statusCode: res.statusCode,
      duration,
    };

    if (res.statusCode >= 500) {
      reqWithLog.log.error(logData, `${req.method} ${req.path} ${res.statusCode} ${duration}ms`);
    } else if (res.statusCode >= 400) {
      reqWithLog.log.warn(logData, `${req.method} ${req.path} ${res.statusCode} ${duration}ms`);
    } else {
      reqWithLog.log.info(logData, `${req.method} ${req.path} ${res.statusCode} ${duration}ms`);
    }
  });

  next();
};

/**
 * Log business events with structured data
 */
export const logEvent = {
  // Video events
  videoUploaded: (log: Logger, data: LogEventData): void => {
    log.info(
      {
        event: 'video_uploaded',
        videoId: data.videoId,
        userId: data.userId,
        fileSize: data.fileSize,
        filename: data.filename,
      },
      'Video upload completed'
    );
  },

  videoTranscoded: (log: Logger, data: LogEventData): void => {
    log.info(
      {
        event: 'video_transcoded',
        videoId: data.videoId,
        duration: data.duration,
        resolutions: data.resolutions,
      },
      'Video transcoding completed'
    );
  },

  videoTranscodeFailed: (log: Logger, data: LogEventData): void => {
    log.error(
      {
        event: 'video_transcode_failed',
        videoId: data.videoId,
        error: data.error,
      },
      'Video transcoding failed'
    );
  },

  videoViewed: (log: Logger, data: LogEventData): void => {
    log.info(
      {
        event: 'video_viewed',
        videoId: data.videoId,
        userId: data.userId,
        watchDuration: data.watchDuration,
      },
      'Video view recorded'
    );
  },

  // User events
  userRegistered: (log: Logger, data: LogEventData): void => {
    log.info(
      {
        event: 'user_registered',
        userId: data.userId,
        username: data.username,
      },
      'New user registered'
    );
  },

  userLoggedIn: (log: Logger, data: LogEventData): void => {
    log.info(
      {
        event: 'user_logged_in',
        userId: data.userId,
        username: data.username,
      },
      'User logged in'
    );
  },

  // Channel events
  channelSubscribed: (log: Logger, data: LogEventData): void => {
    log.info(
      {
        event: 'channel_subscribed',
        userId: data.userId,
        channelId: data.channelId,
      },
      'User subscribed to channel'
    );
  },

  // System events
  circuitBreakerOpen: (log: Logger, data: LogEventData): void => {
    log.warn(
      {
        event: 'circuit_breaker_open',
        service: data.service,
        failures: data.failures,
      },
      `Circuit breaker opened for ${data.service}`
    );
  },

  circuitBreakerClose: (log: Logger, data: LogEventData): void => {
    log.info(
      {
        event: 'circuit_breaker_close',
        service: data.service,
      },
      `Circuit breaker closed for ${data.service}`
    );
  },

  rateLimitExceeded: (log: Logger, data: LogEventData): void => {
    log.warn(
      {
        event: 'rate_limit_exceeded',
        endpoint: data.endpoint,
        ip: data.ip,
        userId: data.userId,
      },
      'Rate limit exceeded'
    );
  },

  cacheHit: (log: Logger, data: LogEventData): void => {
    log.debug(
      {
        event: 'cache_hit',
        key: data.key,
      },
      'Cache hit'
    );
  },

  cacheMiss: (log: Logger, data: LogEventData): void => {
    log.debug(
      {
        event: 'cache_miss',
        key: data.key,
      },
      'Cache miss'
    );
  },
};

export default logger;
