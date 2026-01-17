/**
 * Prometheus Metrics Module
 *
 * Provides centralized metrics collection for the distributed cache.
 * Exposes hit/miss ratios, hot key detection, memory usage, and operation latencies.
 */

import client from 'prom-client';

// Create a custom registry to avoid conflicts with default metrics
const register = new client.Registry();

// Add default metrics (CPU, memory, event loop, etc.)
client.collectDefaultMetrics({ register });

// ======================
// Cache Performance Metrics
// ======================

/**
 * Counter for cache hits
 */
export const cacheHits = new client.Counter({
  name: 'cache_hits_total',
  help: 'Total number of cache hits',
  labelNames: ['node'],
  registers: [register],
});

/**
 * Counter for cache misses
 */
export const cacheMisses = new client.Counter({
  name: 'cache_misses_total',
  help: 'Total number of cache misses',
  labelNames: ['node'],
  registers: [register],
});

/**
 * Counter for cache sets
 */
export const cacheSets = new client.Counter({
  name: 'cache_sets_total',
  help: 'Total number of cache set operations',
  labelNames: ['node'],
  registers: [register],
});

/**
 * Counter for cache deletes
 */
export const cacheDeletes = new client.Counter({
  name: 'cache_deletes_total',
  help: 'Total number of cache delete operations',
  labelNames: ['node'],
  registers: [register],
});

/**
 * Counter for cache evictions
 */
export const cacheEvictions = new client.Counter({
  name: 'cache_evictions_total',
  help: 'Total number of LRU evictions',
  labelNames: ['node'],
  registers: [register],
});

/**
 * Counter for cache expirations
 */
export const cacheExpirations = new client.Counter({
  name: 'cache_expirations_total',
  help: 'Total number of TTL expirations',
  labelNames: ['node'],
  registers: [register],
});

/**
 * Gauge for current cache entries count
 */
export const cacheEntriesCurrent = new client.Gauge({
  name: 'cache_entries_current',
  help: 'Current number of entries in cache',
  labelNames: ['node'],
  registers: [register],
});

/**
 * Gauge for current cache memory usage in bytes
 */
export const cacheMemoryBytes = new client.Gauge({
  name: 'cache_memory_bytes',
  help: 'Current memory usage in bytes',
  labelNames: ['node'],
  registers: [register],
});

/**
 * Gauge for cache memory limit in bytes
 */
export const cacheMemoryLimitBytes = new client.Gauge({
  name: 'cache_memory_limit_bytes',
  help: 'Maximum memory limit in bytes',
  labelNames: ['node'],
  registers: [register],
});

/**
 * Gauge for cache hit rate (0-1)
 */
export const cacheHitRate = new client.Gauge({
  name: 'cache_hit_rate',
  help: 'Current cache hit rate (0 to 1)',
  labelNames: ['node'],
  registers: [register],
});

// ======================
// Operation Latency Metrics
// ======================

/**
 * Histogram for cache operation latencies
 */
export const cacheOperationDuration = new client.Histogram({
  name: 'cache_operation_duration_ms',
  help: 'Cache operation duration in milliseconds',
  labelNames: ['node', 'operation'],
  buckets: [0.1, 0.5, 1, 2, 5, 10, 25, 50, 100],
  registers: [register],
});

// ======================
// Hot Key Detection Metrics
// ======================

/**
 * Gauge for hot key access counts (top keys)
 * Updated periodically by the HotKeyDetector
 */
export const hotKeyAccesses = new client.Gauge({
  name: 'cache_hot_key_accesses',
  help: 'Access count for hot keys in the current window',
  labelNames: ['node', 'key'],
  registers: [register],
});

/**
 * Counter for total key accesses (for hot key detection)
 */
export const totalKeyAccesses = new client.Counter({
  name: 'cache_key_accesses_total',
  help: 'Total number of key accesses for hot key detection',
  labelNames: ['node'],
  registers: [register],
});

// ======================
// Cluster Health Metrics
// ======================

/**
 * Gauge for healthy nodes count
 */
export const clusterNodesHealthy = new client.Gauge({
  name: 'cluster_nodes_healthy',
  help: 'Number of healthy nodes in the cluster',
  registers: [register],
});

/**
 * Gauge for total nodes count
 */
export const clusterNodesTotal = new client.Gauge({
  name: 'cluster_nodes_total',
  help: 'Total number of nodes in the cluster',
  registers: [register],
});

/**
 * Counter for node health check failures
 */
export const nodeHealthCheckFailures = new client.Counter({
  name: 'node_health_check_failures_total',
  help: 'Total number of health check failures',
  labelNames: ['node'],
  registers: [register],
});

// ======================
// Circuit Breaker Metrics
// ======================

/**
 * Gauge for circuit breaker state (0=closed, 1=open, 0.5=half-open)
 */
export const circuitBreakerState = new client.Gauge({
  name: 'circuit_breaker_state',
  help: 'Circuit breaker state (0=closed, 1=open, 0.5=half-open)',
  labelNames: ['target_node'],
  registers: [register],
});

/**
 * Counter for circuit breaker trips
 */
export const circuitBreakerTrips = new client.Counter({
  name: 'circuit_breaker_trips_total',
  help: 'Total number of times circuit breaker opened',
  labelNames: ['target_node'],
  registers: [register],
});

// ======================
// Rebalancing Metrics
// ======================

/**
 * Gauge for rebalance in progress (0 or 1)
 */
export const rebalanceInProgress = new client.Gauge({
  name: 'rebalance_in_progress',
  help: 'Whether a rebalance is currently in progress',
  labelNames: ['node'],
  registers: [register],
});

/**
 * Counter for keys moved during rebalancing
 */
export const rebalanceKeysMoved = new client.Counter({
  name: 'rebalance_keys_moved_total',
  help: 'Total number of keys moved during rebalancing',
  labelNames: ['from_node', 'to_node'],
  registers: [register],
});

/**
 * Histogram for rebalance duration
 */
export const rebalanceDuration = new client.Histogram({
  name: 'rebalance_duration_seconds',
  help: 'Duration of rebalancing operations in seconds',
  buckets: [1, 5, 10, 30, 60, 120, 300],
  registers: [register],
});

// ======================
// Persistence Metrics
// ======================

/**
 * Counter for snapshots created
 */
export const snapshotsCreated = new client.Counter({
  name: 'snapshots_created_total',
  help: 'Total number of snapshots created',
  labelNames: ['node'],
  registers: [register],
});

/**
 * Counter for snapshots loaded
 */
export const snapshotsLoaded = new client.Counter({
  name: 'snapshots_loaded_total',
  help: 'Total number of snapshots loaded at startup',
  labelNames: ['node'],
  registers: [register],
});

/**
 * Gauge for entries loaded from snapshot
 */
export const snapshotEntriesLoaded = new client.Gauge({
  name: 'snapshot_entries_loaded',
  help: 'Number of entries loaded from the last snapshot',
  labelNames: ['node'],
  registers: [register],
});

/**
 * Histogram for snapshot creation duration
 */
export const snapshotDuration = new client.Histogram({
  name: 'snapshot_duration_seconds',
  help: 'Duration of snapshot creation in seconds',
  labelNames: ['node'],
  buckets: [0.1, 0.5, 1, 2, 5, 10],
  registers: [register],
});

// ======================
// Helper Functions
// ======================

/**
 * Get the Prometheus registry
 */
export function getRegistry() {
  return register;
}

/**
 * Get metrics in Prometheus text format
 */
export async function getMetrics() {
  return register.metrics();
}

/**
 * Get content type for Prometheus metrics
 */
export function getContentType() {
  return register.contentType;
}

/**
 * Update cache stats metrics from LRU cache stats
 * @param {string} nodeId - Node identifier
 * @param {object} stats - Stats from LRUCache.getStats()
 */
export function updateCacheStats(nodeId, stats) {
  cacheEntriesCurrent.labels(nodeId).set(stats.size || 0);
  cacheMemoryBytes.labels(nodeId).set(stats.currentMemoryBytes || 0);

  const totalOps = stats.hits + stats.misses;
  if (totalOps > 0) {
    cacheHitRate.labels(nodeId).set(stats.hits / totalOps);
  }
}

/**
 * Record a cache operation with timing
 * @param {string} nodeId - Node identifier
 * @param {string} operation - Operation type (get, set, delete)
 * @param {number} durationMs - Duration in milliseconds
 */
export function recordOperation(nodeId, operation, durationMs) {
  cacheOperationDuration.labels(nodeId, operation).observe(durationMs);
}

/**
 * Hot Key Detector class
 * Tracks key access patterns to identify hot keys
 */
export class HotKeyDetector {
  constructor(nodeId, options = {}) {
    this.nodeId = nodeId;
    this.windowMs = options.windowMs || 60000; // 1 minute window
    this.threshold = options.threshold || 0.01; // 1% of traffic
    this.maxTrackedKeys = options.maxTrackedKeys || 10000;
    this.accessCounts = new Map();
    this.totalAccesses = 0;

    // Periodic reset
    this.resetInterval = setInterval(() => this.reset(), this.windowMs);
  }

  /**
   * Record a key access
   * @param {string} key
   */
  recordAccess(key) {
    const currentCount = this.accessCounts.get(key) || 0;
    this.accessCounts.set(key, currentCount + 1);
    this.totalAccesses++;
    totalKeyAccesses.labels(this.nodeId).inc();

    // Limit tracked keys to prevent memory bloat
    if (this.accessCounts.size > this.maxTrackedKeys) {
      // Remove least accessed keys
      const sorted = [...this.accessCounts.entries()].sort(
        (a, b) => a[1] - b[1]
      );
      const toRemove = sorted.slice(
        0,
        this.accessCounts.size - this.maxTrackedKeys
      );
      for (const [k] of toRemove) {
        this.accessCounts.delete(k);
      }
    }
  }

  /**
   * Get current hot keys
   * @returns {Array} Hot keys with access counts and percentages
   */
  getHotKeys() {
    if (this.totalAccesses === 0) return [];

    const minCount = this.totalAccesses * this.threshold;
    const hotKeys = [];

    for (const [key, count] of this.accessCounts) {
      if (count >= minCount) {
        hotKeys.push({
          key,
          accessCount: count,
          percentage: ((count / this.totalAccesses) * 100).toFixed(2) + '%',
        });
      }
    }

    return hotKeys.sort((a, b) => b.accessCount - a.accessCount).slice(0, 10);
  }

  /**
   * Update Prometheus metrics with current hot keys
   */
  updateMetrics() {
    // Reset all hot key metrics first
    hotKeyAccesses.reset();

    // Set metrics for current hot keys
    const hotKeys = this.getHotKeys();
    for (const { key, accessCount } of hotKeys) {
      hotKeyAccesses.labels(this.nodeId, key).set(accessCount);
    }
  }

  /**
   * Reset counters (called at end of each window)
   */
  reset() {
    // Update metrics before reset
    this.updateMetrics();

    this.accessCounts.clear();
    this.totalAccesses = 0;
  }

  /**
   * Clean up
   */
  destroy() {
    if (this.resetInterval) {
      clearInterval(this.resetInterval);
    }
  }
}

export default {
  register,
  getRegistry,
  getMetrics,
  getContentType,
  updateCacheStats,
  recordOperation,
  HotKeyDetector,
  // Metrics
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
};
