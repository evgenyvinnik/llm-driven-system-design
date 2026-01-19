/**
 * Structured JSON logging with Pino.
 *
 * WHY: Structured logging is essential for production typeahead systems:
 * - Machine-parseable logs for aggregation (ELK, Splunk, Datadog)
 * - Consistent log format across all services
 * - Request tracing with correlation IDs
 * - Performance metrics embedded in logs
 */
import pino from 'pino';
import pinoHttp from 'pino-http';
import crypto from 'crypto';

// Create base logger with structured output
const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  formatters: {
    level: (label) => ({ level: label }),
  },
  base: {
    service: 'typeahead',
    version: process.env.APP_VERSION || '1.0.0',
    env: process.env.NODE_ENV || 'development',
    pid: process.pid,
  },
  timestamp: pino.stdTimeFunctions.isoTime,
});

/**
 * HTTP request logging middleware.
 * Logs request/response with timing and correlation ID.
 */
export const httpLogger = pinoHttp({
  logger,
  genReqId: (req) => req.headers['x-request-id'] || crypto.randomUUID(),
  customProps: (req, res) => ({
    requestId: req.id,
  }),
  customLogLevel: (req, res, err) => {
    if (res.statusCode >= 500 || err) return 'error';
    if (res.statusCode >= 400) return 'warn';
    return 'info';
  },
  customSuccessMessage: (req, res) => {
    return `${req.method} ${req.url} completed`;
  },
  customErrorMessage: (req, res, err) => {
    return `${req.method} ${req.url} failed: ${err?.message || 'unknown error'}`;
  },
  serializers: {
    req: (req) => ({
      id: req.id,
      method: req.method,
      url: req.url,
      query: req.query?.q ? req.query.q.substring(0, 50) : undefined, // Truncate for privacy
      userId: req.headers['x-user-id'] || 'anonymous',
    }),
    res: (res) => ({
      statusCode: res.statusCode,
    }),
  },
});

/**
 * Audit logger for sensitive operations.
 * Used for tracking admin actions, filter changes, etc.
 */
export const auditLogger = {
  /**
   * Log filter list changes
   */
  logFilterChange(action, phrase, reason, adminUserId = 'system') {
    logger.info({
      type: 'audit',
      event: 'filter_change',
      action, // 'add' or 'remove'
      phrase: phrase?.substring(0, 50),
      reason,
      adminUserId,
    });
  },

  /**
   * Log trie rebuild operations
   */
  logTrieRebuild(triggeredBy, phraseCount, durationMs) {
    logger.info({
      type: 'audit',
      event: 'trie_rebuild',
      triggeredBy, // 'scheduled', 'manual', 'threshold'
      phraseCount,
      durationMs,
    });
  },

  /**
   * Log cache invalidation
   */
  logCacheInvalidation(pattern, reason, adminUserId = 'system') {
    logger.info({
      type: 'audit',
      event: 'cache_invalidation',
      pattern: pattern?.substring(0, 50),
      reason,
      adminUserId,
    });
  },

  /**
   * Log rate limit violations
   */
  logRateLimitViolation(clientId, endpoint, currentRate, limit) {
    logger.warn({
      type: 'audit',
      event: 'rate_limit_exceeded',
      clientId,
      endpoint,
      currentRate,
      limit,
    });
  },

  /**
   * Log idempotent operation skip
   */
  logIdempotencySkip(idempotencyKey, operation) {
    logger.info({
      type: 'audit',
      event: 'idempotency_skip',
      idempotencyKey,
      operation,
    });
  },

  /**
   * Log circuit breaker state change
   */
  logCircuitStateChange(circuitName, oldState, newState, reason) {
    logger.warn({
      type: 'audit',
      event: 'circuit_state_change',
      circuitName,
      oldState,
      newState,
      reason,
    });
  },
};

export default logger;
