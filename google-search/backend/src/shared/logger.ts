import pino, { Logger } from 'pino';
import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { config } from '../config/index.js';

// Extend Express Request to include logger
declare global {
  namespace Express {
    interface Request {
      log?: Logger;
    }
  }
}

/**
 * Structured JSON logger with pino
 *
 * WHY: Structured logging enables:
 * - Machine-parseable logs for aggregation (ELK, CloudWatch, etc.)
 * - Consistent log format across all services
 * - Trace correlation via request IDs
 * - Log level filtering in production
 */
const logger: Logger = pino({
  level: config.nodeEnv === 'production' ? 'info' : 'debug',
  formatters: {
    level: (label: string) => ({ level: label }),
    bindings: () => ({
      service: 'google-search-backend',
      version: process.env.npm_package_version || '1.0.0',
    }),
  },
  timestamp: pino.stdTimeFunctions.isoTime,
  // Pretty print in development
  transport:
    config.nodeEnv === 'development'
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
 * Create a child logger with request context
 */
export const createRequestLogger = (req: Request): Logger => {
  return logger.child({
    requestId: req.headers['x-request-id'] || crypto.randomUUID(),
    method: req.method,
    path: req.path,
    ip: req.ip,
  });
};

/**
 * Express middleware for request logging
 */
export const requestLoggerMiddleware = (req: Request, res: Response, next: NextFunction): void => {
  const startTime = Date.now();
  const requestId = (req.headers['x-request-id'] as string) || crypto.randomUUID();

  // Attach logger to request for use in handlers
  req.log = logger.child({
    requestId,
    method: req.method,
    path: req.path,
    ip: req.ip,
  });

  // Set request ID header for tracing
  res.setHeader('x-request-id', requestId);

  // Log request start
  req.log.info({ event: 'request_start' }, `${req.method} ${req.path}`);

  // Log response on finish
  res.on('finish', () => {
    const duration = Date.now() - startTime;
    const logData = {
      event: 'request_complete',
      statusCode: res.statusCode,
      durationMs: duration,
    };

    if (res.statusCode >= 500) {
      req.log?.error(logData, `${req.method} ${req.path} - ${res.statusCode}`);
    } else if (res.statusCode >= 400) {
      req.log?.warn(logData, `${req.method} ${req.path} - ${res.statusCode}`);
    } else {
      req.log?.info(logData, `${req.method} ${req.path} - ${res.statusCode}`);
    }
  });

  next();
};

export interface AuditLogDetails {
  actor?: string;
  resource: string;
  resourceId?: string;
  outcome: string;
  metadata?: Record<string, unknown>;
  ipAddress?: string;
}

/**
 * Audit logger for admin operations
 */
export const auditLog = (action: string, details: AuditLogDetails): void => {
  logger.info(
    {
      type: 'audit',
      action,
      actor: details.actor || 'system',
      resource: details.resource,
      resourceId: details.resourceId,
      outcome: details.outcome,
      metadata: details.metadata,
      ipAddress: details.ipAddress,
    },
    `Audit: ${action} on ${details.resource}`
  );
};

export { logger };
