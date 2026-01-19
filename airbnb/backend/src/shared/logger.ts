/**
 * Structured JSON Logger using Pino
 *
 * Benefits of structured logging:
 * - Machine parseable for log aggregation (Loki, ELK, CloudWatch)
 * - Consistent format across all services
 * - Easy filtering and searching by fields
 * - Request tracing with correlation IDs
 * - Performance metrics embedded in logs
 */

import pino, { type Logger } from 'pino';
import { v4 as uuidv4 } from 'uuid';
import type { Request, Response, NextFunction } from 'express';

// Determine log level from environment
const LOG_LEVEL = process.env.LOG_LEVEL || 'info';
const NODE_ENV = process.env.NODE_ENV || 'development';

// Create the base logger
const logger = pino({
  level: LOG_LEVEL,
  // Use pino-pretty in development for readable logs
  transport: NODE_ENV === 'development'
    ? {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'SYS:standard',
          ignore: 'pid,hostname',
        },
      }
    : undefined,
  // Base context added to all logs
  base: {
    service: 'airbnb-api',
    env: NODE_ENV,
  },
  // Custom timestamp format
  timestamp: pino.stdTimeFunctions.isoTime,
  // Redact sensitive fields
  redact: {
    paths: ['password', 'token', 'authorization', 'cookie', 'req.headers.cookie', 'req.headers.authorization'],
    censor: '[REDACTED]',
  },
});

/**
 * Express middleware for request logging
 * Adds request ID and logs request/response details
 */
export function requestLogger(req: Request, res: Response, next: NextFunction): void {
  // Generate or use existing request ID
  const requestId = (req.headers['x-request-id'] as string) || uuidv4();
  req.requestId = requestId;
  res.setHeader('x-request-id', requestId);

  // Create child logger with request context
  req.log = logger.child({
    requestId,
    method: req.method,
    path: req.path,
    userAgent: req.headers['user-agent'],
    ip: req.ip || req.socket?.remoteAddress,
  });

  const start = process.hrtime.bigint();

  // Log request start
  req.log.info({ query: req.query }, 'Request started');

  // Log response on finish
  res.on('finish', () => {
    const durationNs = Number(process.hrtime.bigint() - start);
    const durationMs = durationNs / 1e6;

    const logData = {
      status: res.statusCode,
      durationMs: Math.round(durationMs * 100) / 100,
      userId: req.user?.id,
    };

    if (res.statusCode >= 500) {
      req.log?.error(logData, 'Request failed');
    } else if (res.statusCode >= 400) {
      req.log?.warn(logData, 'Request error');
    } else {
      req.log?.info(logData, 'Request completed');
    }
  });

  next();
}

/**
 * Create a child logger for a specific module/service
 */
export function createModuleLogger(module: string): Logger {
  return logger.child({ module });
}

interface ErrorWithCode extends Error {
  code?: string;
}

/**
 * Log an error with full stack trace and context
 */
export function logError(
  error: ErrorWithCode,
  context: Record<string, unknown> = {},
  message = 'Error occurred'
): void {
  logger.error({
    ...context,
    error: {
      name: error.name,
      message: error.message,
      stack: error.stack,
      code: error.code,
    },
  }, message);
}

/**
 * Log a business event (booking, search, etc.)
 */
export function logBusinessEvent(eventType: string, data: Record<string, unknown>): void {
  logger.info({
    eventType,
    eventData: data,
    timestamp: new Date().toISOString(),
  }, `Business event: ${eventType}`);
}

/**
 * Log a performance metric
 */
export function logPerformance(
  operation: string,
  durationMs: number,
  context: Record<string, unknown> = {}
): void {
  const level = durationMs > 1000 ? 'warn' : 'info';
  logger[level]({
    operation,
    durationMs,
    ...context,
  }, `Performance: ${operation}`);
}

/**
 * Log a security event (auth failures, suspicious activity)
 */
export function logSecurityEvent(eventType: string, data: Record<string, unknown>): void {
  logger.warn({
    security: true,
    eventType,
    ...data,
    timestamp: new Date().toISOString(),
  }, `Security event: ${eventType}`);
}

export default logger;
