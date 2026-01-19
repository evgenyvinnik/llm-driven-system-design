/**
 * Structured logging with pino
 *
 * Provides consistent structured logging across all services with:
 * - Request correlation IDs for distributed tracing
 * - Child loggers for contextual logging per request
 * - Audit logging for security-relevant events
 * - Configurable log levels via environment
 */
import pino, { Logger, Bindings } from 'pino';
import { v4 as uuid } from 'uuid';
import { Request, Response, NextFunction } from 'express';

// Extended request type with logger
declare global {
  namespace Express {
    interface Request {
      log?: Logger;
    }
  }
}

export interface AuditLogData {
  userId?: string;
  deviceId?: string;
  contentId?: string;
  profileId?: string;
  ipAddress?: string;
  userAgent?: string;
  details?: Record<string, unknown>;
}

// Base logger configuration
export const logger: Logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  formatters: {
    level: (label: string) => ({ level: label }),
    bindings: (bindings: Bindings) => ({
      pid: bindings.pid,
      host: bindings.hostname,
      service: 'apple-tv-api'
    })
  },
  timestamp: pino.stdTimeFunctions.isoTime,
  // In development, use pretty printing
  ...(process.env.NODE_ENV !== 'production' && {
    transport: {
      target: 'pino-pretty',
      options: {
        colorize: true,
        translateTime: 'SYS:standard',
        ignore: 'pid,hostname'
      }
    }
  })
});

// Audit logger for security-relevant events
export const auditLogger: Logger = pino({
  level: 'info',
  formatters: {
    level: (label: string) => ({ level: label, logType: 'audit' })
  },
  timestamp: pino.stdTimeFunctions.isoTime,
  // In production, write to separate audit log file
  ...(process.env.NODE_ENV === 'production' && {
    transport: {
      target: 'pino/file',
      options: { destination: './logs/audit.log' }
    }
  })
});

// Audit event types
export const AuditEvents = {
  LICENSE_ISSUED: 'drm.license.issued',
  LICENSE_REVOKED: 'drm.license.revoked',
  DOWNLOAD_STARTED: 'download.started',
  DOWNLOAD_DELETED: 'download.deleted',
  DEVICE_REGISTERED: 'device.registered',
  DEVICE_REMOVED: 'device.removed',
  PROFILE_CREATED: 'profile.created',
  PROFILE_DELETED: 'profile.deleted',
  SUBSCRIPTION_CHANGED: 'subscription.changed',
  CONTENT_ACCESSED: 'content.accessed',
  PLAYBACK_STARTED: 'playback.started',
  LOGIN_SUCCESS: 'auth.login.success',
  LOGIN_FAILED: 'auth.login.failed',
  LOGOUT: 'auth.logout'
} as const;

export type AuditEventType = typeof AuditEvents[keyof typeof AuditEvents];

/**
 * Log an audit event
 * @param event - Event type from AuditEvents
 * @param data - Event data including userId, deviceId, etc.
 */
export function auditLog(event: AuditEventType, data: AuditLogData): void {
  auditLogger.info({
    event,
    userId: data.userId,
    deviceId: data.deviceId,
    contentId: data.contentId,
    profileId: data.profileId,
    ipAddress: data.ipAddress,
    userAgent: data.userAgent,
    details: data.details
  }, `audit:${event}`);
}

/**
 * Create a child logger with request context
 * @param req - Express request object
 * @returns Child logger with request context
 */
export function createRequestLogger(req: Request): Logger {
  const requestId = (req.headers['x-request-id'] as string) || uuid();
  return logger.child({
    requestId,
    userId: req.session?.userId,
    profileId: req.session?.profileId,
    method: req.method,
    path: req.path,
    userAgent: req.headers['user-agent']
  });
}

/**
 * Express middleware to attach logger to request
 */
export function requestLoggerMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  req.log = createRequestLogger(req);
  const start = Date.now();

  res.on('finish', () => {
    const duration = Date.now() - start;
    const logData = {
      statusCode: res.statusCode,
      duration,
      contentLength: res.get('content-length')
    };

    if (res.statusCode >= 500) {
      req.log?.error(logData, 'request failed');
    } else if (res.statusCode >= 400) {
      req.log?.warn(logData, 'request error');
    } else {
      req.log?.info(logData, 'request completed');
    }
  });

  next();
}
