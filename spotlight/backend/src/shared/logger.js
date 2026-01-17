import pino from 'pino';

// Create structured JSON logger with pino
const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  formatters: {
    level: (label) => {
      return { level: label };
    }
  },
  base: {
    service: 'spotlight',
    version: '1.0.0',
    pid: process.pid
  },
  timestamp: () => `,"timestamp":"${new Date().toISOString()}"`,
  // In development, use pino-pretty if available
  transport: process.env.NODE_ENV !== 'production' && process.env.LOG_PRETTY === 'true'
    ? { target: 'pino-pretty', options: { colorize: true } }
    : undefined
});

// Create child loggers for specific components
export const searchLogger = logger.child({ component: 'search' });
export const indexLogger = logger.child({ component: 'index' });
export const suggestionsLogger = logger.child({ component: 'suggestions' });
export const healthLogger = logger.child({ component: 'health' });

// Audit logger for security-relevant events
export const auditLogger = logger.child({ component: 'audit', audit: true });

/**
 * Log search operation with standardized fields
 * @param {Object} params - Search parameters
 * @param {string} params.query - The search query
 * @param {string} params.userId - User ID (if authenticated)
 * @param {number} params.resultCount - Number of results returned
 * @param {number} params.latencyMs - Search latency in milliseconds
 * @param {string[]} params.sources - Sources queried (local, provider, cloud)
 * @param {string} params.requestId - Request tracking ID
 */
export function logSearch({ query, userId, resultCount, latencyMs, sources, requestId }) {
  searchLogger.info({
    query,
    userId,
    resultCount,
    latencyMs,
    sources,
    requestId
  }, 'Search completed');
}

/**
 * Log index operation with standardized fields
 * @param {Object} params - Index parameters
 * @param {string} params.operation - Operation type (add, update, delete, bulk)
 * @param {string} params.documentType - Type of document (file, app, contact, web)
 * @param {string} params.documentId - Document identifier
 * @param {number} params.latencyMs - Operation latency in milliseconds
 * @param {boolean} params.success - Whether operation succeeded
 * @param {string} params.error - Error message if failed
 * @param {string} params.idempotencyKey - Idempotency key if provided
 */
export function logIndexOperation({ operation, documentType, documentId, latencyMs, success, error, idempotencyKey }) {
  const logData = {
    operation,
    documentType,
    documentId,
    latencyMs,
    success
  };

  if (idempotencyKey) {
    logData.idempotencyKey = idempotencyKey;
  }

  if (error) {
    logData.error = error;
    indexLogger.error(logData, 'Index operation failed');
  } else {
    indexLogger.info(logData, 'Index operation completed');
  }
}

/**
 * Log audit event for security tracking
 * @param {Object} params - Audit parameters
 * @param {string} params.eventType - Type of event (login, logout, permission_denied, rate_limit_exceeded, etc.)
 * @param {string} params.userId - User ID
 * @param {string} params.ip - Client IP address
 * @param {Object} params.details - Additional event details
 */
export function logAuditEvent({ eventType, userId, ip, details }) {
  auditLogger.info({
    eventType,
    userId,
    ip,
    details
  }, `Audit: ${eventType}`);
}

/**
 * Log circuit breaker state change
 * @param {Object} params - Circuit breaker parameters
 * @param {string} params.name - Circuit breaker name
 * @param {string} params.state - New state (OPEN, HALF_OPEN, CLOSED)
 * @param {number} params.failures - Number of failures
 */
export function logCircuitBreakerState({ name, state, failures }) {
  const logLevel = state === 'OPEN' ? 'warn' : 'info';
  logger[logLevel]({
    component: 'circuit_breaker',
    name,
    state,
    failures
  }, `Circuit breaker ${name} is ${state}`);
}

export default logger;
