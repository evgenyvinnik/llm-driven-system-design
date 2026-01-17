import client from 'prom-client';

// Create a Registry to register metrics
const register = new client.Registry();

// Add default metrics (CPU, memory, event loop, etc.)
client.collectDefaultMetrics({ register });

// HTTP Request duration histogram
export const httpRequestDuration = new client.Histogram({
  name: 'http_request_duration_seconds',
  help: 'Duration of HTTP requests in seconds',
  labelNames: ['method', 'route', 'status_code'],
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [register],
});

// HTTP Request counter
export const httpRequestsTotal = new client.Counter({
  name: 'http_requests_total',
  help: 'Total number of HTTP requests',
  labelNames: ['method', 'route', 'status_code'],
  registers: [register],
});

// Playback events counter
export const playbackEventsTotal = new client.Counter({
  name: 'playback_events_total',
  help: 'Total playback events',
  labelNames: ['event_type', 'device_type'],
  registers: [register],
});

// Stream count counter
export const streamCountsTotal = new client.Counter({
  name: 'stream_counts_total',
  help: 'Total stream counts (for royalty tracking)',
  registers: [register],
});

// Active streams gauge
export const activeStreams = new client.Gauge({
  name: 'active_streams',
  help: 'Number of currently active streams',
  registers: [register],
});

// Search operations counter
export const searchOperationsTotal = new client.Counter({
  name: 'search_operations_total',
  help: 'Total search operations',
  labelNames: ['type'],
  registers: [register],
});

// Playlist operations counter
export const playlistOperationsTotal = new client.Counter({
  name: 'playlist_operations_total',
  help: 'Total playlist operations',
  labelNames: ['operation'],
  registers: [register],
});

// Recommendation latency histogram
export const recommendationLatency = new client.Histogram({
  name: 'recommendation_generation_seconds',
  help: 'Time to generate recommendations',
  labelNames: ['algorithm'],
  buckets: [0.1, 0.25, 0.5, 1, 2, 5, 10],
  registers: [register],
});

// Cache hit/miss counters
export const cacheHitsTotal = new client.Counter({
  name: 'cache_hits_total',
  help: 'Total cache hits',
  labelNames: ['cache_type'],
  registers: [register],
});

export const cacheMissesTotal = new client.Counter({
  name: 'cache_misses_total',
  help: 'Total cache misses',
  labelNames: ['cache_type'],
  registers: [register],
});

// Rate limit counter
export const rateLimitHitsTotal = new client.Counter({
  name: 'rate_limit_hits_total',
  help: 'Total rate limit hits',
  labelNames: ['endpoint', 'scope'],
  registers: [register],
});

// Auth events counter
export const authEventsTotal = new client.Counter({
  name: 'auth_events_total',
  help: 'Total authentication events',
  labelNames: ['event', 'success'],
  registers: [register],
});

// Idempotency deduplication counter
export const idempotencyDeduplicationsTotal = new client.Counter({
  name: 'idempotency_deduplications_total',
  help: 'Total requests deduplicated by idempotency key',
  labelNames: ['operation'],
  registers: [register],
});

// Database connection pool metrics
export const dbPoolConnections = new client.Gauge({
  name: 'db_pool_connections',
  help: 'Database connection pool metrics',
  labelNames: ['state'],
  registers: [register],
});

// Express middleware for metrics collection
export function metricsMiddleware(req, res, next) {
  const start = Date.now();

  res.on('finish', () => {
    const duration = (Date.now() - start) / 1000;
    const route = req.route?.path || req.path || 'unknown';

    httpRequestDuration.observe(
      {
        method: req.method,
        route: route,
        status_code: res.statusCode,
      },
      duration
    );

    httpRequestsTotal.inc({
      method: req.method,
      route: route,
      status_code: res.statusCode,
    });
  });

  next();
}

// Metrics endpoint handler
export async function metricsHandler(req, res) {
  res.set('Content-Type', register.contentType);
  res.send(await register.metrics());
}

export { register };
export default {
  register,
  httpRequestDuration,
  httpRequestsTotal,
  playbackEventsTotal,
  streamCountsTotal,
  activeStreams,
  searchOperationsTotal,
  playlistOperationsTotal,
  recommendationLatency,
  cacheHitsTotal,
  cacheMissesTotal,
  rateLimitHitsTotal,
  authEventsTotal,
  idempotencyDeduplicationsTotal,
  dbPoolConnections,
  metricsMiddleware,
  metricsHandler,
};
