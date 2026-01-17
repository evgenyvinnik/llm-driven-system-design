import pino from 'pino';
import config from '../config/index.js';

// Create base logger with structured JSON output
const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  formatters: {
    level: (label) => ({ level: label }),
  },
  base: {
    service: 'shopify-api',
    version: process.env.APP_VERSION || '1.0.0',
    port: config.server.port,
  },
  // Use pretty printing in development
  transport: process.env.NODE_ENV !== 'production' ? {
    target: 'pino-pretty',
    options: {
      colorize: true,
      translateTime: 'SYS:standard',
      ignore: 'pid,hostname',
    },
  } : undefined,
});

/**
 * Create a child logger with request context
 * @param {object} context - Request context (requestId, storeId, userId, etc.)
 * @returns {pino.Logger} Child logger instance
 */
export function createRequestLogger(context) {
  return logger.child(context);
}

/**
 * Express middleware for request logging
 * Adds request logger to req object and logs request completion
 */
export function requestLoggingMiddleware(req, res, next) {
  const requestId = req.headers['x-request-id'] || crypto.randomUUID();
  const startTime = Date.now();

  // Create child logger with request context
  req.log = logger.child({
    requestId,
    method: req.method,
    path: req.path,
    storeId: req.storeId || null,
    userAgent: req.headers['user-agent'],
    ip: req.ip || req.connection?.remoteAddress,
  });

  // Add request ID to response headers
  res.setHeader('X-Request-ID', requestId);

  // Log request completion
  res.on('finish', () => {
    const duration = Date.now() - startTime;
    const logData = {
      statusCode: res.statusCode,
      durationMs: duration,
      contentLength: res.get('content-length'),
    };

    if (res.statusCode >= 500) {
      req.log.error(logData, 'request failed');
    } else if (res.statusCode >= 400) {
      req.log.warn(logData, 'request completed with client error');
    } else {
      req.log.info(logData, 'request completed');
    }
  });

  next();
}

/**
 * Audit logger for tracking important business events
 * @param {object} context - Actor context (storeId, userId, userType, ip)
 * @param {string} action - Action performed (e.g., 'order.created', 'inventory.adjusted')
 * @param {object} resource - Resource affected (type, id)
 * @param {object} changes - Before/after state
 */
export function auditLog(context, action, resource, changes) {
  logger.info({
    audit: true,
    storeId: context.storeId,
    actorId: context.userId,
    actorType: context.userType || 'system',
    action,
    resourceType: resource.type,
    resourceId: resource.id,
    changes,
    ip: context.ip,
    timestamp: new Date().toISOString(),
  }, `AUDIT: ${action}`);
}

export default logger;
