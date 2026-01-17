/**
 * Structured JSON Logging Module with Pino
 *
 * Provides centralized, structured logging for the distributed cache.
 * Features:
 * - JSON format for log aggregation (ELK, Loki, etc.)
 * - Request ID tracking
 * - Log levels: trace, debug, info, warn, error, fatal
 * - Child loggers with context
 */

import pino from 'pino';
import pinoHttp from 'pino-http';

// Environment configuration
const LOG_LEVEL = process.env.LOG_LEVEL || 'info';
const NODE_ID = process.env.NODE_ID || 'unknown';
const NODE_ENV = process.env.NODE_ENV || 'development';

// Pretty print in development, JSON in production
const transport =
  NODE_ENV === 'development'
    ? {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'SYS:standard',
          ignore: 'pid,hostname',
        },
      }
    : undefined;

/**
 * Create the base logger instance
 */
const baseLogger = pino({
  level: LOG_LEVEL,
  transport,
  base: {
    nodeId: NODE_ID,
    service: 'distributed-cache',
  },
  timestamp: pino.stdTimeFunctions.isoTime,
  formatters: {
    level: (label) => ({ level: label }),
  },
  // Redact sensitive fields
  redact: {
    paths: ['req.headers.authorization', 'req.headers["x-admin-key"]'],
    censor: '[REDACTED]',
  },
});

/**
 * Create a child logger with additional context
 * @param {object} context - Additional context to include in all logs
 * @returns {pino.Logger}
 */
export function createLogger(context = {}) {
  return baseLogger.child(context);
}

/**
 * Create HTTP request logger middleware for Express
 * @param {object} options - Additional pino-http options
 * @returns {Function} Express middleware
 */
export function createHttpLogger(options = {}) {
  return pinoHttp({
    logger: baseLogger,
    // Generate request ID
    genReqId: (req) => {
      return req.headers['x-request-id'] || crypto.randomUUID();
    },
    // Custom log level based on response status
    customLogLevel: (req, res, err) => {
      if (res.statusCode >= 500 || err) {
        return 'error';
      }
      if (res.statusCode >= 400) {
        return 'warn';
      }
      return 'info';
    },
    // Custom success message
    customSuccessMessage: (req, res) => {
      return `${req.method} ${req.url} ${res.statusCode}`;
    },
    // Custom error message
    customErrorMessage: (req, res, err) => {
      return `${req.method} ${req.url} ${res.statusCode} - ${err.message}`;
    },
    // Custom request serializer
    serializers: {
      req: (req) => ({
        method: req.method,
        url: req.url,
        query: req.query,
        params: req.params,
        remoteAddress: req.remoteAddress,
      }),
      res: (res) => ({
        statusCode: res.statusCode,
      }),
    },
    // Don't log health checks at info level
    autoLogging: {
      ignore: (req) => {
        return req.url === '/health' || req.url === '/metrics';
      },
    },
    ...options,
  });
}

/**
 * Log cache operations
 */
export const cacheLogger = baseLogger.child({ component: 'cache' });

/**
 * Log cluster operations
 */
export const clusterLogger = baseLogger.child({ component: 'cluster' });

/**
 * Log admin operations
 */
export const adminLogger = baseLogger.child({ component: 'admin' });

/**
 * Log persistence operations
 */
export const persistenceLogger = baseLogger.child({ component: 'persistence' });

/**
 * Log rebalancing operations
 */
export const rebalanceLogger = baseLogger.child({ component: 'rebalance' });

/**
 * Log circuit breaker events
 */
export const circuitBreakerLogger = baseLogger.child({
  component: 'circuit-breaker',
});

// ======================
// Structured Log Helpers
// ======================

/**
 * Log a cache hit event
 * @param {string} key
 * @param {number} durationMs
 */
export function logCacheHit(key, durationMs) {
  cacheLogger.debug({ key, durationMs, hit: true }, 'cache_hit');
}

/**
 * Log a cache miss event
 * @param {string} key
 * @param {number} durationMs
 */
export function logCacheMiss(key, durationMs) {
  cacheLogger.debug({ key, durationMs, hit: false }, 'cache_miss');
}

/**
 * Log a cache set event
 * @param {string} key
 * @param {number} ttl
 * @param {number} durationMs
 */
export function logCacheSet(key, ttl, durationMs) {
  cacheLogger.debug({ key, ttl, durationMs }, 'cache_set');
}

/**
 * Log a cache delete event
 * @param {string} key
 */
export function logCacheDelete(key) {
  cacheLogger.debug({ key }, 'cache_delete');
}

/**
 * Log an eviction event
 * @param {string} key
 * @param {string} reason - 'lru' or 'memory'
 */
export function logEviction(key, reason) {
  cacheLogger.info({ key, reason }, 'cache_eviction');
}

/**
 * Log a TTL expiration event
 * @param {string} key
 */
export function logExpiration(key) {
  cacheLogger.debug({ key }, 'cache_expiration');
}

/**
 * Log node health change
 * @param {string} nodeUrl
 * @param {boolean} healthy
 * @param {string} reason
 */
export function logNodeHealthChange(nodeUrl, healthy, reason) {
  const level = healthy ? 'info' : 'warn';
  clusterLogger[level](
    { nodeUrl, healthy, reason },
    healthy ? 'node_healthy' : 'node_unhealthy'
  );
}

/**
 * Log node added to cluster
 * @param {string} nodeUrl
 */
export function logNodeAdded(nodeUrl) {
  clusterLogger.info({ nodeUrl }, 'node_added');
}

/**
 * Log node removed from cluster
 * @param {string} nodeUrl
 * @param {string} reason
 */
export function logNodeRemoved(nodeUrl, reason) {
  clusterLogger.warn({ nodeUrl, reason }, 'node_removed');
}

/**
 * Log admin authentication failure
 * @param {string} ip
 * @param {string} endpoint
 */
export function logAdminAuthFailure(ip, endpoint) {
  adminLogger.warn({ ip, endpoint }, 'admin_auth_failure');
}

/**
 * Log admin operation
 * @param {string} operation
 * @param {object} details
 */
export function logAdminOperation(operation, details) {
  adminLogger.info({ operation, ...details }, 'admin_operation');
}

/**
 * Log circuit breaker state change
 * @param {string} targetNode
 * @param {string} state - 'closed', 'open', 'half-open'
 */
export function logCircuitBreakerStateChange(targetNode, state) {
  const level = state === 'open' ? 'warn' : 'info';
  circuitBreakerLogger[level](
    { targetNode, state },
    'circuit_breaker_state_change'
  );
}

/**
 * Log snapshot creation
 * @param {string} nodeId
 * @param {number} entries
 * @param {number} durationMs
 */
export function logSnapshotCreated(nodeId, entries, durationMs) {
  persistenceLogger.info(
    { nodeId, entries, durationMs },
    'snapshot_created'
  );
}

/**
 * Log snapshot load
 * @param {string} nodeId
 * @param {number} entries
 * @param {number} durationMs
 */
export function logSnapshotLoaded(nodeId, entries, durationMs) {
  persistenceLogger.info({ nodeId, entries, durationMs }, 'snapshot_loaded');
}

/**
 * Log rebalance start
 * @param {string} reason
 * @param {number} keysToMove
 */
export function logRebalanceStart(reason, keysToMove) {
  rebalanceLogger.info({ reason, keysToMove }, 'rebalance_start');
}

/**
 * Log rebalance progress
 * @param {number} keysMoved
 * @param {number} totalKeys
 */
export function logRebalanceProgress(keysMoved, totalKeys) {
  rebalanceLogger.info(
    { keysMoved, totalKeys, progress: ((keysMoved / totalKeys) * 100).toFixed(1) + '%' },
    'rebalance_progress'
  );
}

/**
 * Log rebalance complete
 * @param {number} keysMoved
 * @param {number} durationMs
 */
export function logRebalanceComplete(keysMoved, durationMs) {
  rebalanceLogger.info({ keysMoved, durationMs }, 'rebalance_complete');
}

/**
 * Log hot keys detected
 * @param {Array} hotKeys
 */
export function logHotKeysDetected(hotKeys) {
  if (hotKeys.length > 0) {
    cacheLogger.info({ hotKeys: hotKeys.slice(0, 5) }, 'hot_keys_detected');
  }
}

export default baseLogger;
