/**
 * Shared Modules Export.
 *
 * Centralizes exports from all shared modules for convenient imports.
 *
 * @module shared
 */

// Logger module
export {
  logger,
  httpLogger,
  auditLogger,
  createChildLogger,
  logDelivery,
  auditToken,
  auditAuth,
  auditAdmin,
} from "./logger.js";

// Metrics module
export {
  httpRequestDuration,
  httpRequestTotal,
  notificationsSent,
  notificationDeliveryLatency,
  pendingNotifications,
  notificationsInFlight,
  activeConnections,
  connectionEvents,
  tokenOperations,
  tokenLookupDuration,
  cacheOperations,
  circuitBreakerState,
  circuitBreakerEvents,
  idempotencyChecks,
  dependencyHealth,
  metricsMiddleware,
  getMetrics,
  getMetricsContentType,
  registry,
} from "./metrics.js";

// Circuit breaker module
export {
  createCircuitBreaker,
  getPubSubCircuitBreaker,
  createWebSocketCircuitBreaker,
  getCircuitBreakerHealth,
} from "./circuitBreaker.js";
export type { CircuitBreakerOptions, CircuitBreakerHealth } from "./circuitBreaker.js";

// Cache module
export {
  getTokenFromCache,
  setTokenInCache,
  setTokenInvalidInCache,
  invalidateTokenCache,
  checkIdempotency,
  markNotificationProcessed,
  getConnectionFromCache,
  setConnectionInCache,
  removeConnectionFromCache,
  CACHE_TTL,
  CACHE_KEYS,
} from "./cache.js";
