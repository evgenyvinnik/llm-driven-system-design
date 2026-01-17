import { generateId } from '../utils/index.js';
import { metricsService } from '../services/metrics.js';

/**
 * Request ID middleware - adds unique ID to each request for tracing
 */
export function requestIdMiddleware(req, res, next) {
  req.id = req.headers['x-request-id'] || generateId();
  res.setHeader('X-Request-ID', req.id);
  next();
}

/**
 * Request logging middleware - logs requests and records metrics
 */
export function requestLoggerMiddleware(req, res, next) {
  const start = Date.now();

  // Log request start
  console.log(`[${req.id}] ${req.method} ${req.path} - Started`);

  res.on('finish', () => {
    const duration = Date.now() - start;

    // Record metrics
    metricsService.recordRequest({
      method: req.method,
      path: req.route?.path || req.path,
      status: res.statusCode,
      duration,
    });

    // Log request completion
    const logLevel = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info';
    const message = `[${req.id}] ${req.method} ${req.path} - ${res.statusCode} (${duration}ms)`;

    if (logLevel === 'error') {
      console.error(message);
    } else if (logLevel === 'warn') {
      console.warn(message);
    } else {
      console.log(message);
    }

    // Warn about slow requests
    if (duration > 1000) {
      console.warn(`[${req.id}] Slow request: ${req.method} ${req.path} took ${duration}ms`);
    }
  });

  next();
}

/**
 * Error handler middleware
 */
export function errorHandlerMiddleware(err, req, res, next) {
  console.error(`[${req.id}] Error handling ${req.method} ${req.path}:`, err);

  // Record error metrics
  metricsService.recordError({
    method: req.method,
    path: req.path,
    error: err.name || 'Error',
  });

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
