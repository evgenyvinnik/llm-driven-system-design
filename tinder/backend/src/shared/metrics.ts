import client from 'prom-client';
import { alertThresholds } from './config.js';

/**
 * Prometheus metrics registry and collectors.
 * Provides observability for swipes, matches, messages, and system health.
 */

// Create a new registry
export const registry = new client.Registry();

// Add default metrics (CPU, memory, etc.)
client.collectDefaultMetrics({ register: registry });

// ============================================================================
// HTTP Metrics
// ============================================================================

/**
 * Counter for total HTTP requests.
 */
export const httpRequestsTotal = new client.Counter({
  name: 'http_requests_total',
  help: 'Total number of HTTP requests',
  labelNames: ['method', 'path', 'status'],
  registers: [registry],
});

/**
 * Histogram for HTTP request duration.
 */
export const httpRequestDuration = new client.Histogram({
  name: 'http_request_duration_seconds',
  help: 'HTTP request duration in seconds',
  labelNames: ['method', 'path', 'status'],
  buckets: [0.01, 0.05, 0.1, 0.2, 0.5, 1, 2, 5],
  registers: [registry],
});

// ============================================================================
// Swipe Metrics
// ============================================================================

/**
 * Counter for total swipes.
 * Labels: direction (like/pass), result (success/error/rate_limited/duplicate)
 */
export const swipesTotal = new client.Counter({
  name: 'swipes_total',
  help: 'Total number of swipe actions',
  labelNames: ['direction', 'result'],
  registers: [registry],
});

/**
 * Histogram for swipe processing duration.
 */
export const swipeProcessingDuration = new client.Histogram({
  name: 'swipe_processing_duration_seconds',
  help: 'Swipe processing duration in seconds',
  labelNames: ['direction'],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1],
  registers: [registry],
});

/**
 * Gauge for swipe rate per user (for rate limiting visibility).
 */
export const swipeRateGauge = new client.Gauge({
  name: 'swipe_rate_per_user',
  help: 'Current swipe rate per user in the window',
  labelNames: ['user_id'],
  registers: [registry],
});

// ============================================================================
// Match Metrics
// ============================================================================

/**
 * Counter for total matches created.
 */
export const matchesTotal = new client.Counter({
  name: 'matches_total',
  help: 'Total number of matches created',
  registers: [registry],
});

/**
 * Gauge for active matches (not unmatched).
 */
export const activeMatchesGauge = new client.Gauge({
  name: 'active_matches',
  help: 'Number of active matches',
  registers: [registry],
});

/**
 * Counter for unmatches.
 */
export const unmatchesTotal = new client.Counter({
  name: 'unmatches_total',
  help: 'Total number of unmatches',
  registers: [registry],
});

/**
 * Histogram for match rate (percentage of likes that result in matches).
 */
export const matchRateHistogram = new client.Histogram({
  name: 'match_rate',
  help: 'Match rate as percentage of likes',
  buckets: [0.01, 0.02, 0.05, 0.1, 0.15, 0.2, 0.3, 0.5],
  registers: [registry],
});

// ============================================================================
// Message Metrics
// ============================================================================

/**
 * Counter for total messages sent.
 */
export const messagesTotal = new client.Counter({
  name: 'messages_total',
  help: 'Total number of messages sent',
  registers: [registry],
});

/**
 * Histogram for message delivery latency (time from send to WebSocket delivery).
 */
export const messageDeliveryLatency = new client.Histogram({
  name: 'message_delivery_latency_seconds',
  help: 'Message delivery latency in seconds',
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 5],
  registers: [registry],
});

/**
 * Gauge for unread messages per user.
 */
export const unreadMessagesGauge = new client.Gauge({
  name: 'unread_messages',
  help: 'Number of unread messages',
  labelNames: ['user_id'],
  registers: [registry],
});

// ============================================================================
// Cache Metrics
// ============================================================================

/**
 * Counter for cache hits.
 */
export const cacheHitsTotal = new client.Counter({
  name: 'cache_hits_total',
  help: 'Total cache hits',
  labelNames: ['cache_type'],
  registers: [registry],
});

/**
 * Counter for cache misses.
 */
export const cacheMissesTotal = new client.Counter({
  name: 'cache_misses_total',
  help: 'Total cache misses',
  labelNames: ['cache_type'],
  registers: [registry],
});

/**
 * Gauge for cache hit rate.
 */
export const cacheHitRateGauge = new client.Gauge({
  name: 'cache_hit_rate',
  help: 'Cache hit rate percentage',
  labelNames: ['cache_type'],
  registers: [registry],
});

// ============================================================================
// WebSocket Metrics
// ============================================================================

/**
 * Gauge for active WebSocket connections.
 */
export const websocketConnectionsGauge = new client.Gauge({
  name: 'websocket_connections_active',
  help: 'Number of active WebSocket connections',
  registers: [registry],
});

/**
 * Counter for WebSocket messages.
 */
export const websocketMessagesTotal = new client.Counter({
  name: 'websocket_messages_total',
  help: 'Total WebSocket messages',
  labelNames: ['type', 'direction'],
  registers: [registry],
});

// ============================================================================
// Database Metrics
// ============================================================================

/**
 * Gauge for database connection pool size.
 */
export const dbPoolSizeGauge = new client.Gauge({
  name: 'db_pool_size',
  help: 'Database connection pool size',
  labelNames: ['state'],
  registers: [registry],
});

/**
 * Histogram for database query duration.
 */
export const dbQueryDuration = new client.Histogram({
  name: 'db_query_duration_seconds',
  help: 'Database query duration in seconds',
  labelNames: ['operation'],
  buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1],
  registers: [registry],
});

// ============================================================================
// Alert Threshold Gauges
// ============================================================================

/**
 * Gauge for alert threshold values (for Grafana/Prometheus alerting).
 */
export const alertThresholdGauge = new client.Gauge({
  name: 'alert_threshold',
  help: 'Configured alert thresholds',
  labelNames: ['metric', 'level'],
  registers: [registry],
});

// Set initial threshold values
alertThresholdGauge.set({ metric: 'redis_memory', level: 'warning' }, alertThresholds.redisMemoryWarning);
alertThresholdGauge.set({ metric: 'redis_memory', level: 'critical' }, alertThresholds.redisMemoryCritical);
alertThresholdGauge.set({ metric: 'websocket_connections', level: 'warning' }, alertThresholds.websocketConnectionsWarning);
alertThresholdGauge.set({ metric: 'websocket_connections', level: 'critical' }, alertThresholds.websocketConnectionsCritical);
alertThresholdGauge.set({ metric: 'cache_hit_rate', level: 'target' }, alertThresholds.cacheHitRateTarget);
alertThresholdGauge.set({ metric: 'cache_hit_rate', level: 'warning' }, alertThresholds.cacheHitRateWarning);
alertThresholdGauge.set({ metric: 'api_latency', level: 'warning' }, alertThresholds.apiLatencyWarning);
alertThresholdGauge.set({ metric: 'api_latency', level: 'critical' }, alertThresholds.apiLatencyCritical);

// ============================================================================
// Discovery Metrics
// ============================================================================

/**
 * Counter for discovery deck requests.
 */
export const discoveryDeckRequestsTotal = new client.Counter({
  name: 'discovery_deck_requests_total',
  help: 'Total discovery deck requests',
  labelNames: ['source'],
  registers: [registry],
});

/**
 * Histogram for discovery deck generation time.
 */
export const discoveryDeckDuration = new client.Histogram({
  name: 'discovery_deck_duration_seconds',
  help: 'Time to generate discovery deck',
  buckets: [0.05, 0.1, 0.2, 0.5, 1, 2, 5],
  registers: [registry],
});

/**
 * Gauge for average candidates per deck.
 */
export const discoveryDeckSizeGauge = new client.Gauge({
  name: 'discovery_deck_size',
  help: 'Number of candidates returned in discovery deck',
  registers: [registry],
});

// ============================================================================
// Rate Limiting Metrics
// ============================================================================

/**
 * Counter for rate limited requests.
 */
export const rateLimitedRequestsTotal = new client.Counter({
  name: 'rate_limited_requests_total',
  help: 'Total rate limited requests',
  labelNames: ['endpoint'],
  registers: [registry],
});

// ============================================================================
// Idempotency Metrics
// ============================================================================

/**
 * Counter for idempotent (duplicate) requests.
 */
export const idempotentRequestsTotal = new client.Counter({
  name: 'idempotent_requests_total',
  help: 'Total idempotent (duplicate) requests',
  labelNames: ['operation'],
  registers: [registry],
});

/**
 * Returns all metrics in Prometheus text format.
 */
export async function getMetrics(): Promise<string> {
  return registry.metrics();
}

/**
 * Returns content type for metrics endpoint.
 */
export function getMetricsContentType(): string {
  return registry.contentType;
}
