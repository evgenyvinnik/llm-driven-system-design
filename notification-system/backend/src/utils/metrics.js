import client from 'prom-client';

// Create a registry for metrics
const register = new client.Registry();

// Add default metrics (CPU, memory, event loop lag, etc.)
client.collectDefaultMetrics({
  register,
  prefix: 'notification_system_',
});

// Custom metrics for notifications

// Counter for total notifications sent
export const notificationsSentCounter = new client.Counter({
  name: 'notification_system_notifications_sent_total',
  help: 'Total number of notifications sent',
  labelNames: ['channel', 'priority', 'status'],
  registers: [register],
});

// Counter for notification delivery attempts
export const deliveryAttemptsCounter = new client.Counter({
  name: 'notification_system_delivery_attempts_total',
  help: 'Total number of delivery attempts',
  labelNames: ['channel', 'success'],
  registers: [register],
});

// Histogram for notification processing duration
export const processingDurationHistogram = new client.Histogram({
  name: 'notification_system_processing_duration_seconds',
  help: 'Duration of notification processing in seconds',
  labelNames: ['channel', 'priority'],
  buckets: [0.01, 0.05, 0.1, 0.5, 1, 2, 5, 10],
  registers: [register],
});

// Histogram for HTTP request duration
export const httpRequestDuration = new client.Histogram({
  name: 'notification_system_http_request_duration_seconds',
  help: 'Duration of HTTP requests in seconds',
  labelNames: ['method', 'route', 'status_code'],
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [register],
});

// Gauge for queue depth
export const queueDepthGauge = new client.Gauge({
  name: 'notification_system_queue_depth',
  help: 'Current number of messages in queue',
  labelNames: ['queue', 'priority'],
  registers: [register],
});

// Counter for rate-limited requests
export const rateLimitedCounter = new client.Counter({
  name: 'notification_system_rate_limited_total',
  help: 'Total number of rate-limited requests',
  labelNames: ['type', 'channel'],
  registers: [register],
});

// Counter for deduplicated notifications
export const deduplicatedCounter = new client.Counter({
  name: 'notification_system_deduplicated_total',
  help: 'Total number of deduplicated notifications',
  registers: [register],
});

// Gauge for circuit breaker state
export const circuitBreakerState = new client.Gauge({
  name: 'notification_system_circuit_breaker_state',
  help: 'Circuit breaker state (0=closed, 1=open, 2=half-open)',
  labelNames: ['channel'],
  registers: [register],
});

// Counter for circuit breaker state changes
export const circuitBreakerStateChanges = new client.Counter({
  name: 'notification_system_circuit_breaker_state_changes_total',
  help: 'Total number of circuit breaker state changes',
  labelNames: ['channel', 'from_state', 'to_state'],
  registers: [register],
});

// Counter for idempotency cache hits
export const idempotencyCacheHits = new client.Counter({
  name: 'notification_system_idempotency_cache_hits_total',
  help: 'Total number of idempotency cache hits (duplicate requests)',
  registers: [register],
});

// Counter for retries
export const retryCounter = new client.Counter({
  name: 'notification_system_retries_total',
  help: 'Total number of retry attempts',
  labelNames: ['channel', 'attempt'],
  registers: [register],
});

// Gauge for active connections
export const activeConnections = new client.Gauge({
  name: 'notification_system_active_connections',
  help: 'Number of active connections',
  labelNames: ['type'],
  registers: [register],
});

// Express middleware for HTTP request metrics
export function metricsMiddleware(req, res, next) {
  const start = Date.now();

  res.on('finish', () => {
    const duration = (Date.now() - start) / 1000;
    const route = req.route?.path || req.path;

    httpRequestDuration
      .labels(req.method, route, res.statusCode.toString())
      .observe(duration);
  });

  next();
}

// Get metrics endpoint handler
export async function getMetrics(req, res) {
  try {
    res.set('Content-Type', register.contentType);
    res.end(await register.metrics());
  } catch (error) {
    res.status(500).end(error.message);
  }
}

// Export the registry for custom metrics
export { register };

export default {
  notificationsSentCounter,
  deliveryAttemptsCounter,
  processingDurationHistogram,
  httpRequestDuration,
  queueDepthGauge,
  rateLimitedCounter,
  deduplicatedCounter,
  circuitBreakerState,
  circuitBreakerStateChanges,
  idempotencyCacheHits,
  retryCounter,
  activeConnections,
  metricsMiddleware,
  getMetrics,
  register,
};
