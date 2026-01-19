/**
 * Structured JSON logging with pino
 * Provides consistent log format across all services
 */

import pino, { Logger } from 'pino';
import type { Request, Response, NextFunction } from 'express';
import { SERVER_CONFIG } from './config.js';

// Extended Request interface to include log and requestId
export interface LoggedRequest extends Request {
  log: Logger;
  requestId: string;
}

// Create the base logger
const logger: Logger = pino({
  level: SERVER_CONFIG.logLevel,
  formatters: {
    level: (label: string) => {
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
 */
export function createLogger(bindings: Record<string, unknown>): Logger {
  return logger.child(bindings);
}

/**
 * Request logger middleware for Express
 * Logs incoming requests with timing information
 */
export function requestLogger(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const startTime = Date.now();
  const requestId =
    (req.headers['x-request-id'] as string) ||
    `req-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

  // Attach logger and requestId to request object
  (req as LoggedRequest).log = logger.child({ requestId });
  (req as LoggedRequest).requestId = requestId;

  // Log request start
  (req as LoggedRequest).log.info(
    {
      type: 'request',
      method: req.method,
      path: req.path,
      query: req.query,
      userAgent: req.get('user-agent'),
      ip: req.ip || req.socket?.remoteAddress,
    },
    `Incoming ${req.method} ${req.path}`
  );

  // Override res.end to log response
  const originalEnd = res.end.bind(res) as typeof res.end;
  (res.end as unknown) = function (
    chunk?: unknown,
    encodingOrCallback?: BufferEncoding | (() => void),
    callback?: () => void
  ): Response {
    const duration = Date.now() - startTime;

    (req as LoggedRequest).log.info(
      {
        type: 'response',
        method: req.method,
        path: req.path,
        statusCode: res.statusCode,
        durationMs: duration,
      },
      `${req.method} ${req.path} ${res.statusCode} ${duration}ms`
    );

    if (typeof encodingOrCallback === 'function') {
      return originalEnd(chunk, encodingOrCallback);
    }
    return originalEnd(chunk, encodingOrCallback, callback);
  };

  next();
}

/**
 * Error logger helper
 */
export function logError(error: Error, context: Record<string, unknown> = {}): void {
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
 */
export function logViewEvent(
  videoId: string,
  category: string,
  metadata: Record<string, unknown> = {}
): void {
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
 */
export function logTrendingCalculation(
  category: string,
  videoCount: number,
  durationMs: number
): void {
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
 */
export function logHeapOperation(
  operation: string,
  heapSize: number,
  durationMicros: number
): void {
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
 */
export function logCacheAccess(cacheType: string, hit: boolean, key: string): void {
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
 */
export function logAlert(
  metric: string,
  value: number,
  threshold: number,
  severity: 'warning' | 'critical'
): void {
  const logFn = severity === 'critical' ? logger.error.bind(logger) : logger.warn.bind(logger);
  logFn(
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
 */
export function logIdempotencyCheck(idempotencyKey: string, duplicate: boolean): void {
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
