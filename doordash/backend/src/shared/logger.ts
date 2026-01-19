import pino, { Logger } from 'pino';
import crypto from 'crypto';
import type { Request, Response, NextFunction } from 'express';

// Create the base logger with structured JSON output
const logger: Logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  formatters: {
    level: (label: string) => ({ level: label }),
  },
  base: {
    service: process.env.SERVICE_NAME || 'doordash-api',
    version: process.env.APP_VERSION || 'dev',
    pid: process.pid,
  },
  timestamp: pino.stdTimeFunctions.isoTime,
});

// Extend Express Request to include log property
declare global {
  namespace Express {
    interface Request {
      log: Logger;
    }
  }
}

/**
 * Express middleware for request logging.
 * Attaches a child logger with request context to each request.
 */
export function requestLogger(req: Request, res: Response, next: NextFunction): void {
  const start = Date.now();
  const requestId = (req.headers['x-request-id'] as string) || crypto.randomUUID();

  // Attach request ID to response header for tracing
  res.setHeader('X-Request-ID', requestId);

  // Create child logger with request context
  req.log = logger.child({
    requestId,
    path: req.path,
    method: req.method,
  });

  // Log request completion
  res.on('finish', () => {
    const duration = Date.now() - start;
    const logData = {
      statusCode: res.statusCode,
      duration,
      userId: req.user?.id,
      contentLength: res.get('content-length'),
    };

    if (res.statusCode >= 500) {
      req.log.error(logData, 'request failed');
    } else if (res.statusCode >= 400) {
      req.log.warn(logData, 'request error');
    } else {
      req.log.info(logData, 'request completed');
    }
  });

  next();
}

/**
 * Create a child logger with a specific context
 */
export function createLogger(context: string): Logger {
  return logger.child({ context });
}

/**
 * Log a business event (order, driver, etc.)
 */
export function logBusinessEvent(
  eventType: string,
  entityType: string,
  entityId: string | number,
  details: Record<string, unknown> = {}
): void {
  logger.info(
    {
      event: eventType,
      entityType,
      entityId,
      ...details,
      timestamp: new Date().toISOString(),
    },
    `${entityType} ${eventType}`
  );
}

/**
 * Log an error with context
 */
export function logError(error: Error, context: Record<string, unknown> = {}): void {
  logger.error(
    {
      error: {
        message: error.message,
        stack: error.stack,
        name: error.name,
      },
      ...context,
    },
    error.message
  );
}

export default logger;
