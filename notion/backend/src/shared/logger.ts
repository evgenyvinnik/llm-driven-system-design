/**
 * @fileoverview Structured JSON logging with pino.
 * Provides consistent logging format across all services with request context,
 * log levels, and structured metadata for observability.
 */

import pino from 'pino';
import type { Request, Response, NextFunction } from 'express';

/**
 * Base logger instance configured for the application.
 * Uses JSON format in production for log aggregation systems,
 * and pretty printing in development for readability.
 */
export const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  formatters: {
    level: (label) => ({ level: label }),
  },
  base: {
    service: 'notion-api',
    version: process.env.APP_VERSION || '1.0.0',
    environment: process.env.NODE_ENV || 'development',
    pid: process.pid,
  },
  timestamp: pino.stdTimeFunctions.isoTime,
  // Use pretty print in development
  ...(process.env.NODE_ENV !== 'production' && {
    transport: {
      target: 'pino/file',
      options: { destination: 1 }, // stdout
    },
  }),
});

/**
 * Extended Express Request with logger context.
 */
declare global {
  namespace Express {
    interface Request {
      log: pino.Logger;
      requestId: string;
    }
  }
}

/**
 * Generates a unique request ID for tracing.
 */
function generateRequestId(): string {
  return `req_${Date.now().toString(36)}_${Math.random().toString(36).substring(2, 9)}`;
}

/**
 * Express middleware that adds structured logging to each request.
 * Creates a child logger with request context for correlation.
 */
export function requestLogger(req: Request, res: Response, next: NextFunction): void {
  const requestId = (req.headers['x-request-id'] as string) || generateRequestId();
  const startTime = Date.now();

  // Attach request ID to response headers for tracing
  res.setHeader('x-request-id', requestId);
  req.requestId = requestId;

  // Create child logger with request context
  req.log = logger.child({
    requestId,
    method: req.method,
    path: req.path,
    userAgent: req.headers['user-agent'],
    ip: req.ip || req.headers['x-forwarded-for'],
  });

  // Log request start at debug level
  req.log.debug({ query: req.query }, 'request started');

  // Log response when finished
  res.on('finish', () => {
    const durationMs = Date.now() - startTime;
    const logData = {
      statusCode: res.statusCode,
      durationMs,
      contentLength: res.get('content-length'),
      userId: req.user?.id,
    };

    if (res.statusCode >= 500) {
      req.log.error(logData, 'request completed with server error');
    } else if (res.statusCode >= 400) {
      req.log.warn(logData, 'request completed with client error');
    } else {
      req.log.info(logData, 'request completed');
    }
  });

  next();
}

/**
 * Log levels for different event types.
 */
export const LogEvents = {
  // Authentication
  USER_LOGIN: 'user.login',
  USER_LOGOUT: 'user.logout',
  USER_LOGIN_FAILED: 'user.login_failed',
  USER_REGISTERED: 'user.registered',

  // Pages
  PAGE_CREATED: 'page.created',
  PAGE_UPDATED: 'page.updated',
  PAGE_DELETED: 'page.deleted',
  PAGE_VIEWED: 'page.viewed',

  // Blocks
  BLOCK_CREATED: 'block.created',
  BLOCK_UPDATED: 'block.updated',
  BLOCK_DELETED: 'block.deleted',
  BLOCK_MOVED: 'block.moved',

  // Workspaces
  WORKSPACE_CREATED: 'workspace.created',
  WORKSPACE_UPDATED: 'workspace.updated',
  WORKSPACE_DELETED: 'workspace.deleted',
  WORKSPACE_MEMBER_ADDED: 'workspace.member_added',
  WORKSPACE_MEMBER_REMOVED: 'workspace.member_removed',

  // Sharing
  PAGE_SHARED: 'page.shared',
  PAGE_UNSHARED: 'page.unshared',
  PERMISSION_CHANGED: 'permission.changed',

  // Operations
  OPERATION_APPLIED: 'operation.applied',
  OPERATION_FAILED: 'operation.failed',

  // System
  CACHE_HIT: 'cache.hit',
  CACHE_MISS: 'cache.miss',
  QUEUE_MESSAGE_SENT: 'queue.message_sent',
  QUEUE_MESSAGE_PROCESSED: 'queue.message_processed',
  QUEUE_MESSAGE_FAILED: 'queue.message_failed',
} as const;

export type LogEvent = (typeof LogEvents)[keyof typeof LogEvents];

/**
 * Logs a structured event with metadata.
 */
export function logEvent(
  event: LogEvent,
  metadata: Record<string, unknown>,
  level: pino.Level = 'info'
): void {
  logger[level]({ event, ...metadata }, `${event}`);
}

export default logger;
