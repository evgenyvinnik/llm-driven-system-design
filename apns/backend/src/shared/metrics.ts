/**
 * Prometheus Metrics Module.
 *
 * Provides centralized metrics collection for the APNs backend.
 * All metrics are exposed via the /metrics endpoint for Prometheus scraping.
 *
 * WHY: Prometheus metrics enable real-time monitoring, alerting, and
 * capacity planning. By instrumenting key operations (notifications,
 * token lookups, WebSocket connections), we can track SLIs like delivery
 * success rate and latency percentiles. This is essential for operating
 * a reliable push notification service.
 *
 * Key metrics categories:
 * - HTTP request latency and status codes
 * - Notification delivery status and latency
 * - Device connection counts
 * - Cache hit/miss ratios
 * - Circuit breaker state
 *
 * @module shared/metrics
 */

import * as promClient from "prom-client";

/**
 * Enable default metrics collection (CPU, memory, event loop, etc.)
 * These provide baseline system health metrics.
 */
promClient.collectDefaultMetrics({
  prefix: "apns_",
  labels: { server_id: `server-${process.env.PORT || 3000}` },
});

// =============================================================================
// HTTP Request Metrics
// =============================================================================

/**
 * HTTP request duration histogram.
 * Tracks latency distribution for all API endpoints.
 * Use for SLI: "99% of requests complete in < Xms"
 */
export const httpRequestDuration = new promClient.Histogram({
  name: "apns_http_request_duration_seconds",
  help: "Duration of HTTP requests in seconds",
  labelNames: ["method", "route", "status_code"],
  buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
});

/**
 * HTTP request counter.
 * Tracks total requests by method, route, and status.
 */
export const httpRequestTotal = new promClient.Counter({
  name: "apns_http_requests_total",
  help: "Total number of HTTP requests",
  labelNames: ["method", "route", "status_code"],
});

// =============================================================================
// Notification Metrics
// =============================================================================

/**
 * Notifications sent counter.
 * Primary metric for tracking notification throughput and success rates.
 * Labels allow filtering by priority and delivery status.
 */
export const notificationsSent = new promClient.Counter({
  name: "apns_notifications_sent_total",
  help: "Total notifications processed",
  labelNames: ["priority", "status"], // status: delivered, queued, expired, failed
});

/**
 * Notification delivery latency histogram.
 * Measures time from notification receipt to delivery/queuing.
 * Critical SLI: "99% of high-priority notifications delivered in < 500ms"
 */
export const notificationDeliveryLatency = new promClient.Histogram({
  name: "apns_notification_delivery_seconds",
  help: "Time from notification creation to delivery/queuing",
  labelNames: ["priority"],
  buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
});

/**
 * Pending notifications gauge.
 * Tracks backlog of notifications waiting for offline devices.
 * Alert if this grows too large (indicates delivery issues or device churn).
 */
export const pendingNotifications = new promClient.Gauge({
  name: "apns_pending_notifications",
  help: "Number of notifications pending for offline devices",
});

/**
 * Notifications in flight gauge.
 * Tracks notifications currently being processed.
 */
export const notificationsInFlight = new promClient.Gauge({
  name: "apns_notifications_in_flight",
  help: "Number of notifications currently being processed",
});

// =============================================================================
// Device Connection Metrics
// =============================================================================

/**
 * Active WebSocket connections gauge.
 * Tracks devices currently connected to this server instance.
 */
export const activeConnections = new promClient.Gauge({
  name: "apns_active_device_connections",
  help: "Number of active WebSocket device connections",
});

/**
 * WebSocket connection events counter.
 * Tracks connection lifecycle (connect, disconnect, error).
 */
export const connectionEvents = new promClient.Counter({
  name: "apns_connection_events_total",
  help: "WebSocket connection lifecycle events",
  labelNames: ["event"], // connect, disconnect, error
});

// =============================================================================
// Token Registry Metrics
// =============================================================================

/**
 * Token operations counter.
 * Tracks token registry activity (register, lookup, invalidate).
 */
export const tokenOperations = new promClient.Counter({
  name: "apns_token_operations_total",
  help: "Token registry operations",
  labelNames: ["operation"], // register, register_update, invalidate, lookup
});

/**
 * Token lookup duration histogram.
 * Measures time to look up a device token (including cache).
 */
export const tokenLookupDuration = new promClient.Histogram({
  name: "apns_token_lookup_duration_seconds",
  help: "Duration of token lookup operations",
  labelNames: ["cache_status"], // hit, miss
  buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25],
});

// =============================================================================
// Cache Metrics
// =============================================================================

/**
 * Cache operations counter.
 * Tracks cache hits and misses for monitoring cache effectiveness.
 * Target: > 80% hit rate for token lookups.
 */
export const cacheOperations = new promClient.Counter({
  name: "apns_cache_operations_total",
  help: "Cache operation outcomes",
  labelNames: ["cache", "operation"], // cache: token, connection; operation: hit, miss, set, delete
});

// =============================================================================
// Circuit Breaker Metrics
// =============================================================================

/**
 * Circuit breaker state gauge.
 * Tracks current state of the APNs connection circuit breaker.
 * Values: 0 = closed (healthy), 1 = open (failing), 2 = half-open (testing)
 */
export const circuitBreakerState = new promClient.Gauge({
  name: "apns_circuit_breaker_state",
  help: "Circuit breaker state (0=closed, 1=open, 2=half-open)",
  labelNames: ["circuit"],
});

/**
 * Circuit breaker events counter.
 * Tracks circuit breaker state transitions.
 */
export const circuitBreakerEvents = new promClient.Counter({
  name: "apns_circuit_breaker_events_total",
  help: "Circuit breaker state transition events",
  labelNames: ["circuit", "event"], // event: open, close, half_open, success, failure, timeout, reject
});

// =============================================================================
// Idempotency Metrics
// =============================================================================

/**
 * Idempotency check counter.
 * Tracks duplicate vs new notification requests.
 */
export const idempotencyChecks = new promClient.Counter({
  name: "apns_idempotency_checks_total",
  help: "Idempotency check results",
  labelNames: ["result"], // new, duplicate
});

// =============================================================================
// Health Check Metrics
// =============================================================================

/**
 * Dependency health gauge.
 * Tracks health of external dependencies (database, Redis).
 * Values: 1 = healthy, 0 = unhealthy
 */
export const dependencyHealth = new promClient.Gauge({
  name: "apns_dependency_health",
  help: "Health status of dependencies (1=healthy, 0=unhealthy)",
  labelNames: ["dependency"], // database, redis
});

// =============================================================================
// Express Middleware
// =============================================================================

/**
 * Express middleware for recording HTTP request metrics.
 * Records request duration and increments request counter.
 *
 * @returns Express middleware function
 */
export function metricsMiddleware() {
  return (
    req: { method: string; route?: { path: string }; path: string },
    res: { statusCode: number; on: (event: string, callback: () => void) => void },
    next: () => void
  ) => {
    const start = Date.now();
    const route = req.route?.path || req.path || "unknown";

    res.on("finish", () => {
      const duration = (Date.now() - start) / 1000;
      const labels = {
        method: req.method,
        route,
        status_code: res.statusCode.toString(),
      };

      httpRequestDuration.observe(labels, duration);
      httpRequestTotal.inc(labels);
    });

    next();
  };
}

// =============================================================================
// Metrics Registry Export
// =============================================================================

/**
 * Get all collected metrics in Prometheus format.
 * Call this to expose metrics via /metrics endpoint.
 *
 * @returns Promise resolving to metrics string in Prometheus format
 */
export async function getMetrics(): Promise<string> {
  return promClient.register.metrics();
}

/**
 * Get the content type for metrics response.
 */
export function getMetricsContentType(): string {
  return promClient.register.contentType;
}

/**
 * Prometheus client registry.
 * Exposed for advanced use cases (custom metrics, clearing, etc.)
 */
export const registry = promClient.register;

export default promClient;
