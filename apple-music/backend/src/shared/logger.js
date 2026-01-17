import pino from 'pino';
import crypto from 'crypto';

/**
 * Structured logger using pino for JSON-formatted logs.
 *
 * Benefits:
 * - JSON format enables log aggregation (Loki, ELK, CloudWatch)
 * - Structured fields allow filtering and alerting on specific attributes
 * - Request correlation via requestId for distributed tracing
 * - Separate audit logger for security-relevant events
 */

// Main application logger
export const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  formatters: {
    level: (label) => ({ level: label })
  },
  base: {
    service: 'apple-music-api',
    version: process.env.APP_VERSION || '1.0.0',
    env: process.env.NODE_ENV || 'development'
  },
  // Pretty print in development for readability
  transport: process.env.NODE_ENV !== 'production' ? {
    target: 'pino/file',
    options: { destination: 1 } // stdout
  } : undefined
});

// Audit logger for security-relevant events
// In production, this could write to a separate stream for compliance
export const auditLogger = logger.child({
  type: 'audit',
  stream: 'security'
});

/**
 * Request logging middleware - attaches logger to each request.
 * Logs request completion with duration, status, and user context.
 */
export function requestLogger(req, res, next) {
  const start = Date.now();
  const requestId = req.headers['x-request-id'] || crypto.randomUUID();

  // Attach child logger with request context
  req.log = logger.child({
    requestId,
    userId: req.user?.id,
    method: req.method,
    path: req.path
  });

  // Set request ID header for response
  res.setHeader('X-Request-ID', requestId);

  // Log when response finishes
  res.on('finish', () => {
    const duration = Date.now() - start;
    const logData = {
      statusCode: res.statusCode,
      durationMs: duration,
      contentLength: res.get('content-length'),
      userAgent: req.headers['user-agent']
    };

    // Use appropriate log level based on status code
    if (res.statusCode >= 500) {
      req.log.error(logData, 'request completed with error');
    } else if (res.statusCode >= 400) {
      req.log.warn(logData, 'request completed with client error');
    } else {
      req.log.info(logData, 'request completed');
    }
  });

  next();
}

/**
 * Audit log helper for security-relevant events.
 * Use for login, logout, permission changes, admin actions.
 */
export function auditLog(action, details = {}) {
  return (req, res, next) => {
    const auditEntry = {
      action,
      userId: req.user?.id,
      ip: req.ip || req.connection?.remoteAddress,
      userAgent: req.headers['user-agent'],
      timestamp: new Date().toISOString(),
      ...details
    };

    res.on('finish', () => {
      auditEntry.statusCode = res.statusCode;
      auditEntry.success = res.statusCode < 400;

      if (auditEntry.success) {
        auditLogger.info(auditEntry, `Audit: ${action}`);
      } else {
        auditLogger.warn(auditEntry, `Audit: ${action} (failed)`);
      }
    });

    next();
  };
}

/**
 * Stream event logger - specialized for music streaming events.
 */
export function logStreamEvent(eventType, userId, trackId, details = {}) {
  logger.info({
    event: eventType,
    userId,
    trackId,
    ...details
  }, `Stream event: ${eventType}`);
}

export default logger;
