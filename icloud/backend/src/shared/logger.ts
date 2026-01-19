/**
 * Structured logging with pino
 *
 * WHY: Structured JSON logging enables efficient log aggregation and querying
 * in production environments. Machine-readable logs allow for automated alerting
 * and analysis while remaining human-readable in development with pino-pretty.
 */

import crypto from 'crypto';
import pino, { Logger } from 'pino';
import type { Request, Response, NextFunction } from 'express';

const isDevelopment = process.env.NODE_ENV === 'development';

// Base logger configuration
const loggerConfig = {
  level: process.env.LOG_LEVEL || (isDevelopment ? 'debug' : 'info'),
  base: {
    service: 'icloud-sync',
    version: process.env.APP_VERSION || '1.0.0',
    env: process.env.NODE_ENV || 'development',
  },
  timestamp: pino.stdTimeFunctions.isoTime,
  formatters: {
    level: (label: string) => ({ level: label }),
  },
};

// Use pino-pretty for development, raw JSON for production
const transport = isDevelopment
  ? {
      target: 'pino-pretty',
      options: {
        colorize: true,
        translateTime: 'SYS:standard',
        ignore: 'pid,hostname',
      },
    }
  : undefined;

export const logger: Logger = pino({
  ...loggerConfig,
  ...(transport && { transport }),
});

/**
 * Create a child logger with additional context
 * Useful for request-scoped logging with correlation IDs
 */
export function createChildLogger(bindings: Record<string, unknown>): Logger {
  return logger.child(bindings);
}

// Extend Express Request type to include log property
declare global {
  namespace Express {
    interface Request {
      log?: Logger;
    }
  }
}

/**
 * Request logging middleware for Express
 * Adds correlation ID and logs request/response details
 */
export function requestLogger(req: Request, res: Response, next: NextFunction): void {
  const correlationId = (req.headers['x-correlation-id'] as string) || crypto.randomUUID();
  const startTime = Date.now();

  // Attach logger to request for use in handlers
  req.log = logger.child({
    correlationId,
    method: req.method,
    path: req.path,
  });

  // Log request
  req.log.info({
    event: 'request.started',
    ip: req.ip,
    userAgent: req.headers['user-agent'],
  });

  // Log response on finish
  res.on('finish', () => {
    const duration = Date.now() - startTime;
    req.log?.info({
      event: 'request.completed',
      statusCode: res.statusCode,
      durationMs: duration,
    });
  });

  // Set correlation ID header for tracing
  res.setHeader('X-Correlation-ID', correlationId);

  next();
}

/**
 * Audit logger for security and compliance events
 * These logs should have longer retention and stricter access controls
 */
export const auditLogger: Logger = logger.child({ type: 'audit' });

export interface AuditEvent {
  type: string;
  userId?: string;
  deviceId?: string;
  resourceType?: string;
  resourceId?: string;
  action?: string;
  metadata?: Record<string, unknown>;
  ipAddress?: string;
  userAgent?: string;
}

export function logAuditEvent(event: AuditEvent): void {
  auditLogger.info({
    event: event.type,
    userId: event.userId,
    deviceId: event.deviceId,
    resourceType: event.resourceType,
    resourceId: event.resourceId,
    action: event.action,
    metadata: event.metadata,
    ipAddress: event.ipAddress,
    userAgent: event.userAgent,
    timestamp: new Date().toISOString(),
  });
}

export default logger;
