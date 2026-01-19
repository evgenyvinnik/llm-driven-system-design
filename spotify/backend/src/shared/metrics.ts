import client, { Registry, Counter, Histogram, Gauge } from 'prom-client';
import type { Request, Response, NextFunction } from 'express';

// Create a Registry to register metrics
const register = new Registry();

// Add default metrics (CPU, memory, event loop, etc.)
client.collectDefaultMetrics({ register });

// HTTP Request duration histogram
export const httpRequestDuration = new Histogram({
  name: 'http_request_duration_seconds',
  help: 'Duration of HTTP requests in seconds',
  labelNames: ['method', 'route', 'status_code'] as const,
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [register],
});

// HTTP Request counter
export const httpRequestsTotal = new Counter({
  name: 'http_requests_total',
  help: 'Total number of HTTP requests',
  labelNames: ['method', 'route', 'status_code'] as const,
  registers: [register],
});

// Playback events counter
export const playbackEventsTotal = new Counter({
  name: 'playback_events_total',
  help: 'Total playback events',
  labelNames: ['event_type', 'device_type'] as const,
  registers: [register],
});

// Stream count counter
export const streamCountsTotal = new Counter({
  name: 'stream_counts_total',
  help: 'Total stream counts (for royalty tracking)',
  registers: [register],
});

// Active streams gauge
export const activeStreams = new Gauge({
  name: 'active_streams',
  help: 'Number of currently active streams',
  registers: [register],
});

// Search operations counter
export const searchOperationsTotal = new Counter({
  name: 'search_operations_total',
  help: 'Total search operations',
  labelNames: ['type'] as const,
  registers: [register],
});

// Playlist operations counter
export const playlistOperationsTotal = new Counter({
  name: 'playlist_operations_total',
  help: 'Total playlist operations',
  labelNames: ['operation'] as const,
  registers: [register],
});

// Recommendation latency histogram
export const recommendationLatency = new Histogram({
  name: 'recommendation_generation_seconds',
  help: 'Time to generate recommendations',
  labelNames: ['algorithm'] as const,
  buckets: [0.1, 0.25, 0.5, 1, 2, 5, 10],
  registers: [register],
});

// Cache hit/miss counters
export const cacheHitsTotal = new Counter({
  name: 'cache_hits_total',
  help: 'Total cache hits',
  labelNames: ['cache_type'] as const,
  registers: [register],
});

export const cacheMissesTotal = new Counter({
  name: 'cache_misses_total',
  help: 'Total cache misses',
  labelNames: ['cache_type'] as const,
  registers: [register],
});

// Rate limit counter
export const rateLimitHitsTotal = new Counter({
  name: 'rate_limit_hits_total',
  help: 'Total rate limit hits',
  labelNames: ['endpoint', 'scope'] as const,
  registers: [register],
});

// Auth events counter
export const authEventsTotal = new Counter({
  name: 'auth_events_total',
  help: 'Total authentication events',
  labelNames: ['event', 'success'] as const,
  registers: [register],
});

// Idempotency deduplication counter
export const idempotencyDeduplicationsTotal = new Counter({
  name: 'idempotency_deduplications_total',
  help: 'Total requests deduplicated by idempotency key',
  labelNames: ['operation'] as const,
  registers: [register],
});

// Database connection pool metrics
export const dbPoolConnections = new Gauge({
  name: 'db_pool_connections',
  help: 'Database connection pool metrics',
  labelNames: ['state'] as const,
  registers: [register],
});

// Express middleware for metrics collection
export function metricsMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
): void {
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
export async function metricsHandler(req: Request, res: Response): Promise<void> {
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
