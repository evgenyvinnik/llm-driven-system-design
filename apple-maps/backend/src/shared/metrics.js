import client from 'prom-client';

/**
 * Prometheus Metrics Module
 *
 * WHY: Prometheus metrics enable:
 * - Real-time visibility into system health and performance
 * - Alerting based on SLIs (latency, error rate, throughput)
 * - Historical analysis for capacity planning
 * - Integration with Grafana dashboards
 * - RED method (Rate, Errors, Duration) observability
 */

// Create a Registry to hold all metrics
const register = new client.Registry();

// Add default metrics (process memory, CPU, event loop, etc.)
client.collectDefaultMetrics({ register });

// ============================================================
// HTTP Request Metrics (RED Method)
// ============================================================

// Request duration histogram - measures latency distribution
const httpRequestDuration = new client.Histogram({
  name: 'http_request_duration_seconds',
  help: 'HTTP request duration in seconds',
  labelNames: ['method', 'route', 'status_code'],
  // Buckets optimized for API latency (50ms to 10s)
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
});
register.registerMetric(httpRequestDuration);

// Request counter - measures throughput
const httpRequestTotal = new client.Counter({
  name: 'http_requests_total',
  help: 'Total number of HTTP requests',
  labelNames: ['method', 'route', 'status_code'],
});
register.registerMetric(httpRequestTotal);

// Active requests gauge - measures concurrent load
const httpActiveRequests = new client.Gauge({
  name: 'http_active_requests',
  help: 'Number of active HTTP requests',
  labelNames: ['method', 'route'],
});
register.registerMetric(httpActiveRequests);

// ============================================================
// Routing Service Metrics
// ============================================================

const routeCalculationDuration = new client.Histogram({
  name: 'routing_calculation_duration_seconds',
  help: 'Time to calculate a route',
  labelNames: ['route_type', 'status'],
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 5],
});
register.registerMetric(routeCalculationDuration);

const routeNodesVisited = new client.Histogram({
  name: 'routing_nodes_visited',
  help: 'Number of nodes visited during route calculation',
  buckets: [10, 50, 100, 250, 500, 1000, 2500, 5000],
});
register.registerMetric(routeNodesVisited);

const routeDistanceMeters = new client.Histogram({
  name: 'routing_distance_meters',
  help: 'Distance of calculated routes in meters',
  buckets: [100, 500, 1000, 5000, 10000, 50000, 100000],
});
register.registerMetric(routeDistanceMeters);

const routeRequestsTotal = new client.Counter({
  name: 'routing_requests_total',
  help: 'Total routing requests',
  labelNames: ['status'], // success, no_route, error
});
register.registerMetric(routeRequestsTotal);

// ============================================================
// Traffic Service Metrics
// ============================================================

const trafficProbesIngested = new client.Counter({
  name: 'traffic_probes_ingested_total',
  help: 'Total GPS probes ingested',
  labelNames: ['status'], // processed, duplicate, error
});
register.registerMetric(trafficProbesIngested);

const trafficSegmentUpdates = new client.Counter({
  name: 'traffic_segment_updates_total',
  help: 'Total traffic segment updates',
});
register.registerMetric(trafficSegmentUpdates);

const trafficIncidentsDetected = new client.Counter({
  name: 'traffic_incidents_detected_total',
  help: 'Total incidents detected',
  labelNames: ['type', 'severity'],
});
register.registerMetric(trafficIncidentsDetected);

const trafficSegmentStaleness = new client.Gauge({
  name: 'traffic_segment_staleness_seconds',
  help: 'Age of most recent traffic data for a segment',
});
register.registerMetric(trafficSegmentStaleness);

// ============================================================
// Cache Metrics
// ============================================================

const cacheHits = new client.Counter({
  name: 'cache_hits_total',
  help: 'Cache hit count',
  labelNames: ['cache_name'],
});
register.registerMetric(cacheHits);

const cacheMisses = new client.Counter({
  name: 'cache_misses_total',
  help: 'Cache miss count',
  labelNames: ['cache_name'],
});
register.registerMetric(cacheMisses);

// ============================================================
// Circuit Breaker Metrics
// ============================================================

const circuitBreakerState = new client.Gauge({
  name: 'circuit_breaker_state',
  help: 'Circuit breaker state (0=closed, 1=open, 0.5=half-open)',
  labelNames: ['name'],
});
register.registerMetric(circuitBreakerState);

const circuitBreakerFailures = new client.Counter({
  name: 'circuit_breaker_failures_total',
  help: 'Circuit breaker failure count',
  labelNames: ['name'],
});
register.registerMetric(circuitBreakerFailures);

const circuitBreakerSuccesses = new client.Counter({
  name: 'circuit_breaker_successes_total',
  help: 'Circuit breaker success count',
  labelNames: ['name'],
});
register.registerMetric(circuitBreakerSuccesses);

// ============================================================
// Database Metrics
// ============================================================

const dbQueryDuration = new client.Histogram({
  name: 'db_query_duration_seconds',
  help: 'Database query duration',
  labelNames: ['query_type', 'status'],
  buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 5],
});
register.registerMetric(dbQueryDuration);

const dbConnectionsActive = new client.Gauge({
  name: 'db_connections_active',
  help: 'Active database connections',
});
register.registerMetric(dbConnectionsActive);

const dbConnectionsIdle = new client.Gauge({
  name: 'db_connections_idle',
  help: 'Idle database connections',
});
register.registerMetric(dbConnectionsIdle);

// ============================================================
// Idempotency Metrics
// ============================================================

const idempotencyHits = new client.Counter({
  name: 'idempotency_hits_total',
  help: 'Idempotent request replays (duplicate requests)',
  labelNames: ['operation'],
});
register.registerMetric(idempotencyHits);

const idempotencyMisses = new client.Counter({
  name: 'idempotency_misses_total',
  help: 'New idempotent requests',
  labelNames: ['operation'],
});
register.registerMetric(idempotencyMisses);

// ============================================================
// Rate Limiting Metrics
// ============================================================

const rateLimitHits = new client.Counter({
  name: 'rate_limit_hits_total',
  help: 'Requests that were rate limited',
  labelNames: ['route'],
});
register.registerMetric(rateLimitHits);

// ============================================================
// Express Middleware
// ============================================================

function metricsMiddleware(req, res, next) {
  // Normalize route for metrics (avoid high cardinality)
  const route = req.route?.path || req.path;
  const normalizedRoute = route.replace(/\/[0-9a-f-]{36}/gi, '/:id').replace(/\/\d+/g, '/:id');

  const labels = { method: req.method, route: normalizedRoute };

  // Track active requests
  httpActiveRequests.inc(labels);

  // Start timer
  const end = httpRequestDuration.startTimer();

  // On response finish
  res.on('finish', () => {
    const finalLabels = { ...labels, status_code: res.statusCode };
    end(finalLabels);
    httpRequestTotal.inc(finalLabels);
    httpActiveRequests.dec(labels);
  });

  next();
}

// ============================================================
// Metrics Endpoint Handler
// ============================================================

async function metricsHandler(req, res) {
  res.set('Content-Type', register.contentType);
  res.end(await register.metrics());
}

// ============================================================
// Exported Metrics for Direct Usage
// ============================================================

export {
  register,
  metricsMiddleware,
  metricsHandler,
  // HTTP metrics
  httpRequestDuration,
  httpRequestTotal,
  httpActiveRequests,
  // Routing metrics
  routeCalculationDuration,
  routeNodesVisited,
  routeDistanceMeters,
  routeRequestsTotal,
  // Traffic metrics
  trafficProbesIngested,
  trafficSegmentUpdates,
  trafficIncidentsDetected,
  trafficSegmentStaleness,
  // Cache metrics
  cacheHits,
  cacheMisses,
  // Circuit breaker metrics
  circuitBreakerState,
  circuitBreakerFailures,
  circuitBreakerSuccesses,
  // Database metrics
  dbQueryDuration,
  dbConnectionsActive,
  dbConnectionsIdle,
  // Idempotency metrics
  idempotencyHits,
  idempotencyMisses,
  // Rate limiting metrics
  rateLimitHits,
};
