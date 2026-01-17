import { generateId } from '../utils/index.js';
import { metricsService } from '../services/metrics.js';
import logger, { createRequestLogger } from '../services/logger.js';

/**
 * Request ID middleware - adds unique ID to each request for tracing
 */
export function requestIdMiddleware(req, res, next) {
  req.id = req.headers['x-request-id'] || generateId();
  res.setHeader('X-Request-ID', req.id);
  // Attach a request-scoped logger
  req.log = createRequestLogger(req);
  next();
}

/**
 * Request logging middleware - logs requests and records metrics using pino
 *
 * WHY structured logging:
 * - Machine-parseable for log aggregation (ELK, Loki, CloudWatch)
 * - Consistent format across all services
 * - Enables filtering and alerting on specific fields
 * - Correlates requests via request IDs for distributed tracing
 */
export function requestLoggerMiddleware(req, res, next) {
  const start = Date.now();
  const log = req.log || logger.child({ requestId: req.id });

  // Log request start at debug level
  log.debug({ method: req.method, path: req.path }, 'Request started');

  res.on('finish', () => {
    const duration = Date.now() - start;

    // Record metrics
    metricsService.recordRequest({
      method: req.method,
      path: req.route?.path || req.path,
      status: res.statusCode,
      duration,
    });

    // Log with appropriate level based on status
    const logData = {
      method: req.method,
      path: req.path,
      status: res.statusCode,
      duration,
      ip: req.ip || req.headers?.['x-forwarded-for']?.split(',')[0],
    };

    if (res.statusCode >= 500) {
      log.error(logData, 'Request failed');
    } else if (res.statusCode >= 400) {
      log.warn(logData, 'Request error');
    } else if (duration > 1000) {
      log.warn({ ...logData, slow: true }, 'Slow request');
    } else {
      log.info(logData, 'Request completed');
    }
  });

  next();
}

/**
 * Error handler middleware
 */
export function errorHandlerMiddleware(err, req, res, next) {
  const log = req.log || logger.child({ requestId: req.id });

  // Record error metrics
  metricsService.recordError({
    method: req.method,
    path: req.path,
    error: err.name || 'Error',
  });

  // Log error with full context
  log.error({
    err,
    method: req.method,
    path: req.path,
    stack: err.stack,
  }, 'Error handling request');

  // Handle operational errors
  if (err.isOperational) {
    return res.status(err.statusCode).json({
      error: err.message,
      requestId: req.id,
      ...(err.retryAfter && { retryAfter: err.retryAfter }),
    });
  }

  // Handle validation errors
  if (err.name === 'ValidationError') {
    return res.status(400).json({
      error: 'Validation failed',
      details: err.message,
      requestId: req.id,
    });
  }

  // Handle syntax errors (bad JSON)
  if (err instanceof SyntaxError && 'body' in err) {
    return res.status(400).json({
      error: 'Invalid JSON',
      requestId: req.id,
    });
  }

  // Generic server error
  res.status(500).json({
    error: 'Internal server error',
    requestId: req.id,
  });
}

/**
 * Not found handler middleware
 */
export function notFoundMiddleware(req, res) {
  res.status(404).json({
    error: 'Not found',
    path: req.path,
    requestId: req.id,
  });
}

/**
 * CORS middleware configuration
 */
export function corsOptions() {
  return {
    origin: true, // Allow all origins in development
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-ID', 'X-API-Key'],
    exposedHeaders: ['X-Request-ID', 'X-RateLimit-Limit', 'X-RateLimit-Remaining', 'X-RateLimit-Reset'],
  };
}
