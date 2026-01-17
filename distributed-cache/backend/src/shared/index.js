/**
 * Shared Modules Index
 *
 * Central export for all shared functionality in the distributed cache.
 */

// Metrics
export {
  getRegistry,
  getMetrics,
  getContentType,
  updateCacheStats,
  recordOperation,
  HotKeyDetector,
  cacheHits,
  cacheMisses,
  cacheSets,
  cacheDeletes,
  cacheEvictions,
  cacheExpirations,
  cacheEntriesCurrent,
  cacheMemoryBytes,
  cacheMemoryLimitBytes,
  cacheHitRate,
  cacheOperationDuration,
  hotKeyAccesses,
  totalKeyAccesses,
  clusterNodesHealthy,
  clusterNodesTotal,
  nodeHealthCheckFailures,
  circuitBreakerState,
  circuitBreakerTrips,
  rebalanceInProgress,
  rebalanceKeysMoved,
  rebalanceDuration,
  snapshotsCreated,
  snapshotsLoaded,
  snapshotEntriesLoaded,
  snapshotDuration,
} from './metrics.js';

// Logging
export {
  default as logger,
  createLogger,
  createHttpLogger,
  cacheLogger,
  clusterLogger,
  adminLogger,
  persistenceLogger,
  rebalanceLogger,
  circuitBreakerLogger,
  logCacheHit,
  logCacheMiss,
  logCacheSet,
  logCacheDelete,
  logEviction,
  logExpiration,
  logNodeHealthChange,
  logNodeAdded,
  logNodeRemoved,
  logAdminAuthFailure,
  logAdminOperation,
  logCircuitBreakerStateChange,
  logSnapshotCreated,
  logSnapshotLoaded,
  logRebalanceStart,
  logRebalanceProgress,
  logRebalanceComplete,
  logHotKeysDetected,
} from './logger.js';

// Authentication
export {
  requireAdminKey,
  logAdminAccess,
  getAdminConfig,
} from './auth.js';

// Circuit Breaker
export {
  createCircuitBreaker,
  getCircuitBreaker,
  executeWithCircuitBreaker,
  removeCircuitBreaker,
  getAllCircuitBreakerStatus,
  resetAllCircuitBreakers,
  createNodeClient,
  healthCheck,
} from './circuit-breaker.js';

// Persistence
export {
  PersistenceManager,
  createPersistenceManager,
} from './persistence.js';

// Rebalancing
export {
  RebalanceManager,
  createRebalanceManager,
} from './rebalance.js';
