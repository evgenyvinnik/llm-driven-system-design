/**
 * Structured JSON logging with pino
 *
 * WHY: Structured logging is essential for:
 * - Centralized log aggregation and search (ELK, Splunk, CloudWatch)
 * - Correlation across distributed services via request IDs
 * - Filtering and alerting on specific fields (e.g., error counts, slow queries)
 * - Audit trail for financial transactions
 */

const pino = require('pino');

// Determine log level based on environment
const level = process.env.LOG_LEVEL || (process.env.NODE_ENV === 'production' ? 'info' : 'debug');

// Create the base logger instance
const logger = pino({
  level,
  // Use pretty printing in development for readability
  transport: process.env.NODE_ENV !== 'production' ? {
    target: 'pino/file',
    options: { destination: 1 }, // stdout
  } : undefined,
  // Base fields included in every log entry
  base: {
    service: 'venmo-api',
    env: process.env.NODE_ENV || 'development',
    pid: process.pid,
  },
  // Customize timestamp format
  timestamp: pino.stdTimeFunctions.isoTime,
  // Redact sensitive fields
  redact: {
    paths: [
      'password',
      'password_hash',
      'pin_hash',
      'session_id',
      'sessionId',
      'authorization',
      'x-session-id',
      'account_number',
      'routing_number',
      'card_token',
      'req.headers.authorization',
      'req.headers["x-session-id"]',
    ],
    remove: true,
  },
});

/**
 * Create a child logger with request context
 * @param {Object} context - Request context (requestId, userId, etc.)
 */
function createRequestLogger(context) {
  return logger.child({
    requestId: context.requestId,
    userId: context.userId,
    ...context,
  });
}

/**
 * Mask sensitive data for logging
 * @param {string} value - Value to mask
 * @param {number} visibleChars - Number of characters to show at the end
 */
function maskSensitive(value, visibleChars = 4) {
  if (!value || typeof value !== 'string') return '****';
  if (value.length <= visibleChars) return '****';
  return '****' + value.slice(-visibleChars);
}

/**
 * Format amount in cents to readable string for logs
 * @param {number} amountCents - Amount in cents
 */
function formatAmount(amountCents) {
  return `$${(amountCents / 100).toFixed(2)}`;
}

/**
 * Log levels and their intended use:
 *
 * FATAL (60): System is unusable, immediate action required
 * ERROR (50): Failed operations, exceptions, service unavailable
 * WARN  (40): Degraded service, retry attempts, rate limit warnings
 * INFO  (30): Normal operations - successful transfers, logins, cashouts
 * DEBUG (20): Detailed diagnostics - full request/response, timing
 * TRACE (10): Very detailed tracing - function entry/exit
 */

module.exports = {
  logger,
  createRequestLogger,
  maskSensitive,
  formatAmount,
};
