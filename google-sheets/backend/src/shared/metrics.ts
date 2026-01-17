/**
 * Prometheus metrics module for observability.
 * Exposes metrics for cell operations, WebSocket connections, cache performance,
 * and database operations.
 *
 * WHY: Prometheus metrics enable monitoring, alerting, and capacity planning.
 * With Grafana dashboards, teams can visualize system health, identify
 * bottlenecks, and set up alerts for SLO violations.
 *
 * @module shared/metrics
 */

import client, {
  Counter,
  Histogram,
  Gauge,
  Registry,
} from 'prom-client';

// Create a new registry for this application
export const register = new Registry();

// Add default metrics (CPU, memory, event loop lag, etc.)
client.collectDefaultMetrics({ register });

/**
 * WebSocket Metrics
 * Track connection count and message throughput
 */
export const wsConnectionsActive = new Gauge({
  name: 'ws_connections_active',
  help: 'Number of active WebSocket connections',
  registers: [register],
});

export const wsMessagesReceived = new Counter({
  name: 'ws_messages_received_total',
  help: 'Total WebSocket messages received',
  labelNames: ['type'],
  registers: [register],
});

export const wsMessagesSent = new Counter({
  name: 'ws_messages_sent_total',
  help: 'Total WebSocket messages sent',
  labelNames: ['type'],
  registers: [register],
});

export const wsMessageLatency = new Histogram({
  name: 'ws_message_latency_ms',
  help: 'WebSocket message processing latency in milliseconds',
  labelNames: ['type'],
  buckets: [5, 10, 25, 50, 100, 250, 500, 1000],
  registers: [register],
});

/**
 * Cell Operation Metrics
 * Track spreadsheet edit operations
 */
export const cellEditsTotal = new Counter({
  name: 'cell_edits_total',
  help: 'Total number of cell edit operations',
  registers: [register],
});

export const cellEditLatency = new Histogram({
  name: 'cell_edit_latency_ms',
  help: 'Cell edit operation latency in milliseconds',
  buckets: [5, 10, 25, 50, 100, 250, 500, 1000],
  registers: [register],
});

export const formulaCalculationsTotal = new Counter({
  name: 'formula_calculations_total',
  help: 'Total number of formula calculations',
  registers: [register],
});

export const formulaCalculationDuration = new Histogram({
  name: 'formula_calculation_duration_ms',
  help: 'Formula calculation duration in milliseconds',
  buckets: [1, 5, 10, 25, 50, 100, 250, 500],
  registers: [register],
});

/**
 * Cache Metrics
 * Track cache hit/miss rates for performance monitoring
 */
export const cacheHits = new Counter({
  name: 'cache_hits_total',
  help: 'Total cache hits',
  labelNames: ['cache_type'],
  registers: [register],
});

export const cacheMisses = new Counter({
  name: 'cache_misses_total',
  help: 'Total cache misses',
  labelNames: ['cache_type'],
  registers: [register],
});

export const cacheOperationDuration = new Histogram({
  name: 'cache_operation_duration_ms',
  help: 'Cache operation duration in milliseconds',
  labelNames: ['operation', 'cache_type'],
  buckets: [1, 2, 5, 10, 25, 50],
  registers: [register],
});

/**
 * Database Metrics
 * Track query performance and connection pool health
 */
export const dbQueryDuration = new Histogram({
  name: 'db_query_duration_ms',
  help: 'Database query duration in milliseconds',
  labelNames: ['query_type'],
  buckets: [5, 10, 25, 50, 100, 250, 500, 1000, 2000],
  registers: [register],
});

export const dbPoolConnectionsActive = new Gauge({
  name: 'db_pool_connections_active',
  help: 'Number of active database connections in the pool',
  registers: [register],
});

export const dbPoolConnectionsWaiting = new Gauge({
  name: 'db_pool_connections_waiting',
  help: 'Number of queries waiting for a connection',
  registers: [register],
});

/**
 * Error Metrics
 * Track application errors for alerting
 */
export const errorsTotal = new Counter({
  name: 'errors_total',
  help: 'Total application errors',
  labelNames: ['type', 'component'],
  registers: [register],
});

/**
 * Circuit Breaker Metrics
 * Track circuit breaker state changes and fallback invocations
 */
export const circuitBreakerState = new Gauge({
  name: 'circuit_breaker_state',
  help: 'Circuit breaker state (0=closed, 1=open, 2=half-open)',
  labelNames: ['name'],
  registers: [register],
});

export const circuitBreakerFallbacks = new Counter({
  name: 'circuit_breaker_fallbacks_total',
  help: 'Total circuit breaker fallback invocations',
  labelNames: ['name'],
  registers: [register],
});

/**
 * Idempotency Metrics
 * Track duplicate request handling
 */
export const idempotencyHits = new Counter({
  name: 'idempotency_hits_total',
  help: 'Total idempotent request replays',
  registers: [register],
});

export const idempotencyMisses = new Counter({
  name: 'idempotency_misses_total',
  help: 'Total first-time idempotent requests',
  registers: [register],
});

/**
 * Health Check Metrics
 */
export const healthCheckStatus = new Gauge({
  name: 'health_check_status',
  help: 'Health check status (1=healthy, 0=unhealthy)',
  labelNames: ['component'],
  registers: [register],
});

export default {
  register,
  wsConnectionsActive,
  wsMessagesReceived,
  wsMessagesSent,
  wsMessageLatency,
  cellEditsTotal,
  cellEditLatency,
  formulaCalculationsTotal,
  formulaCalculationDuration,
  cacheHits,
  cacheMisses,
  cacheOperationDuration,
  dbQueryDuration,
  dbPoolConnectionsActive,
  dbPoolConnectionsWaiting,
  errorsTotal,
  circuitBreakerState,
  circuitBreakerFallbacks,
  idempotencyHits,
  idempotencyMisses,
  healthCheckStatus,
};
