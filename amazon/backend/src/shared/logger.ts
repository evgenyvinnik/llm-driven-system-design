/**
 * Structured JSON Logging with Pino
 *
 * Provides structured logging with correlation IDs for request tracing.
 * All logs are output as JSON for easy parsing by log aggregation tools.
 */
import pino from 'pino';
import crypto from 'crypto';

// Configure logger based on environment
const logger = pino({
  level: process.env.LOG_LEVEL || (process.env.NODE_ENV === 'production' ? 'info' : 'debug'),
  formatters: {
    level: (label) => ({ level: label })
  },
  // Add base fields to all log entries
  base: {
    service: 'amazon-api',
    version: process.env.npm_package_version || '1.0.0'
  },
  // Redact sensitive fields
  redact: {
    paths: ['req.headers.authorization', 'password', 'password_hash', 'token', 'credit_card'],
    censor: '[REDACTED]'
  },
  // Use pretty printing in development
  ...(process.env.NODE_ENV !== 'production' && {
    transport: {
      target: 'pino/file',
      options: { destination: 1 } // stdout
    }
  })
});

/**
 * Create a child logger with request context
 * @param {Object} req - Express request object
 * @returns {Object} Child logger with correlation ID
 */
export function createRequestLogger(req) {
  const correlationId = req.headers['x-correlation-id'] || crypto.randomUUID();

  return logger.child({
    correlationId,
    userId: req.user?.id,
    method: req.method,
    path: req.path,
    ip: req.ip || req.headers['x-forwarded-for'] || req.connection?.remoteAddress
  });
}

/**
 * Express middleware for request logging
 */
export function requestLoggingMiddleware(req, res, next) {
  // Generate or extract correlation ID
  req.correlationId = req.headers['x-correlation-id'] || crypto.randomUUID();

  // Attach logger to request
  req.log = createRequestLogger(req);

  // Set correlation ID in response headers for client tracking
  res.setHeader('X-Correlation-ID', req.correlationId);

  // Log request start
  const startTime = process.hrtime.bigint();

  req.log.info({
    type: 'request_start',
    query: req.query,
    userAgent: req.headers['user-agent']
  }, `${req.method} ${req.path} started`);

  // Log request completion
  res.on('finish', () => {
    const duration = Number(process.hrtime.bigint() - startTime) / 1e6; // Convert to milliseconds

    const logData = {
      type: 'request_complete',
      statusCode: res.statusCode,
      durationMs: duration.toFixed(2)
    };

    if (res.statusCode >= 500) {
      req.log.error(logData, `${req.method} ${req.path} failed`);
    } else if (res.statusCode >= 400) {
      req.log.warn(logData, `${req.method} ${req.path} client error`);
    } else {
      req.log.info(logData, `${req.method} ${req.path} completed`);
    }
  });

  next();
}

/**
 * Log levels for different operations
 */
export const LogEvents = {
  // Order lifecycle events
  ORDER_CREATED: 'order.created',
  ORDER_CONFIRMED: 'order.confirmed',
  ORDER_CANCELLED: 'order.cancelled',
  ORDER_SHIPPED: 'order.shipped',
  ORDER_DELIVERED: 'order.delivered',
  ORDER_REFUNDED: 'order.refunded',

  // Payment events
  PAYMENT_INITIATED: 'payment.initiated',
  PAYMENT_COMPLETED: 'payment.completed',
  PAYMENT_FAILED: 'payment.failed',

  // Inventory events
  INVENTORY_RESERVED: 'inventory.reserved',
  INVENTORY_RELEASED: 'inventory.released',
  INVENTORY_DEPLETED: 'inventory.depleted',

  // Cart events
  CART_ITEM_ADDED: 'cart.item_added',
  CART_ITEM_REMOVED: 'cart.item_removed',
  CART_ABANDONED: 'cart.abandoned',

  // Search events
  SEARCH_PERFORMED: 'search.performed',
  SEARCH_FALLBACK: 'search.fallback',

  // Circuit breaker events
  CIRCUIT_OPENED: 'circuit_breaker.opened',
  CIRCUIT_CLOSED: 'circuit_breaker.closed',
  CIRCUIT_HALF_OPEN: 'circuit_breaker.half_open',

  // Idempotency events
  IDEMPOTENCY_HIT: 'idempotency.hit',
  IDEMPOTENCY_MISS: 'idempotency.miss'
};

export default logger;
