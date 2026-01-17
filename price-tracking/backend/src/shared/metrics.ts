/**
 * Prometheus metrics for the Price Tracking service.
 * Exposes counters, histograms, and gauges for monitoring scrape operations,
 * API performance, alerts, and system health.
 * @module shared/metrics
 */
import { Registry, Counter, Histogram, Gauge, collectDefaultMetrics } from 'prom-client';

/** Prometheus registry for all custom metrics */
export const register = new Registry();

// Collect default Node.js metrics (event loop lag, memory, CPU, etc.)
collectDefaultMetrics({ register });

// ============================================================================
// Scraper Metrics
// ============================================================================

/**
 * Counter for total scrape operations by domain and status.
 * Status: success, failure, rate_limited, circuit_open
 */
export const scrapesTotal = new Counter({
  name: 'price_tracker_scrapes_total',
  help: 'Total number of product scrape attempts',
  labelNames: ['domain', 'status'] as const,
  registers: [register],
});

/**
 * Histogram for scrape duration in seconds.
 * Tracks how long each scrape takes by domain.
 */
export const scrapeDuration = new Histogram({
  name: 'price_tracker_scrape_duration_seconds',
  help: 'Duration of product scrape operations in seconds',
  labelNames: ['domain'] as const,
  buckets: [0.1, 0.5, 1, 2, 5, 10, 30],
  registers: [register],
});

/**
 * Gauge for current scrape queue size.
 * Shows how many products are waiting to be scraped.
 */
export const scrapeQueueSize = new Gauge({
  name: 'price_tracker_scrape_queue_size',
  help: 'Current number of products in the scrape queue',
  registers: [register],
});

/**
 * Gauge for active concurrent scrapes.
 * Shows how many scrapes are currently in progress.
 */
export const activeScrapes = new Gauge({
  name: 'price_tracker_active_scrapes',
  help: 'Number of currently active scrape operations',
  registers: [register],
});

/**
 * Counter for scrape retries by domain.
 * Tracks how often retries are needed.
 */
export const scrapeRetries = new Counter({
  name: 'price_tracker_scrape_retries_total',
  help: 'Total number of scrape retry attempts',
  labelNames: ['domain', 'attempt'] as const,
  registers: [register],
});

// ============================================================================
// Circuit Breaker Metrics
// ============================================================================

/**
 * Gauge for circuit breaker state per domain.
 * Values: 0 = closed (healthy), 1 = half-open (testing), 2 = open (blocked)
 */
export const circuitBreakerState = new Gauge({
  name: 'price_tracker_circuit_breaker_state',
  help: 'Circuit breaker state per domain (0=closed, 1=half-open, 2=open)',
  labelNames: ['domain'] as const,
  registers: [register],
});

/**
 * Counter for circuit breaker state transitions.
 * Tracks when circuits open, close, or go to half-open state.
 */
export const circuitBreakerTransitions = new Counter({
  name: 'price_tracker_circuit_breaker_transitions_total',
  help: 'Total circuit breaker state transitions',
  labelNames: ['domain', 'from_state', 'to_state'] as const,
  registers: [register],
});

// ============================================================================
// Alert Metrics
// ============================================================================

/**
 * Counter for alerts triggered by type.
 * Types: target_reached, price_drop, back_in_stock
 */
export const alertsTriggered = new Counter({
  name: 'price_tracker_alerts_triggered_total',
  help: 'Total number of price alerts triggered',
  labelNames: ['alert_type'] as const,
  registers: [register],
});

/**
 * Counter for alerts sent by channel.
 * Channels: email, push, webhook
 */
export const alertsSent = new Counter({
  name: 'price_tracker_alerts_sent_total',
  help: 'Total number of alerts sent to users',
  labelNames: ['channel', 'status'] as const,
  registers: [register],
});

/**
 * Histogram for alert delivery latency.
 * Measures time from price change detection to notification delivery.
 */
export const alertDeliveryLatency = new Histogram({
  name: 'price_tracker_alert_delivery_latency_seconds',
  help: 'Time from price change detection to alert delivery',
  labelNames: ['channel'] as const,
  buckets: [0.1, 0.5, 1, 5, 10, 30, 60, 300],
  registers: [register],
});

// ============================================================================
// API Metrics
// ============================================================================

/**
 * Counter for HTTP requests by method, path, and status code.
 */
export const httpRequestsTotal = new Counter({
  name: 'price_tracker_http_requests_total',
  help: 'Total number of HTTP requests',
  labelNames: ['method', 'path', 'status'] as const,
  registers: [register],
});

/**
 * Histogram for HTTP request duration in seconds.
 */
export const httpRequestDuration = new Histogram({
  name: 'price_tracker_http_request_duration_seconds',
  help: 'Duration of HTTP requests in seconds',
  labelNames: ['method', 'path'] as const,
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [register],
});

// ============================================================================
// Database Metrics
// ============================================================================

/**
 * Gauge for active database connections in the pool.
 */
export const dbPoolActiveConnections = new Gauge({
  name: 'price_tracker_db_pool_active_connections',
  help: 'Number of active connections in the database pool',
  registers: [register],
});

/**
 * Gauge for idle database connections in the pool.
 */
export const dbPoolIdleConnections = new Gauge({
  name: 'price_tracker_db_pool_idle_connections',
  help: 'Number of idle connections in the database pool',
  registers: [register],
});

/**
 * Histogram for database query duration.
 */
export const dbQueryDuration = new Histogram({
  name: 'price_tracker_db_query_duration_seconds',
  help: 'Duration of database queries in seconds',
  labelNames: ['operation'] as const,
  buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1],
  registers: [register],
});

// ============================================================================
// Cache Metrics
// ============================================================================

/**
 * Counter for cache hits and misses.
 */
export const cacheOperations = new Counter({
  name: 'price_tracker_cache_operations_total',
  help: 'Total cache operations',
  labelNames: ['operation', 'result'] as const,
  registers: [register],
});

// ============================================================================
// Price History Metrics
// ============================================================================

/**
 * Counter for price history records inserted.
 */
export const priceHistoryInserts = new Counter({
  name: 'price_tracker_price_history_inserts_total',
  help: 'Total price history records inserted',
  registers: [register],
});

/**
 * Counter for price history records deleted during retention cleanup.
 */
export const priceHistoryDeleted = new Counter({
  name: 'price_tracker_price_history_deleted_total',
  help: 'Total price history records deleted during retention cleanup',
  registers: [register],
});

/**
 * Gauge for total price history records.
 */
export const priceHistoryTotal = new Gauge({
  name: 'price_tracker_price_history_total',
  help: 'Total number of price history records in the database',
  registers: [register],
});

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Returns the Prometheus metrics in the standard text format.
 * Used by the /metrics endpoint.
 */
export async function getMetrics(): Promise<string> {
  return register.metrics();
}

/**
 * Returns the content type for Prometheus metrics.
 */
export function getContentType(): string {
  return register.contentType;
}
