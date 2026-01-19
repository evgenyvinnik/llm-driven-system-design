import client, { Registry, Counter, Histogram, Gauge } from 'prom-client';
import { Request, Response, NextFunction } from 'express';

/**
 * Prometheus metrics module
 *
 * Metrics enable content recommendation optimization by tracking:
 * - View patterns and watch durations
 * - Popular content identification
 * - User engagement signals
 *
 * All metrics follow Prometheus naming conventions:
 * - Counter: total, count suffix
 * - Gauge: current value, no suffix
 * - Histogram: duration, size, latency suffix
 */

// Create a registry
const register = new Registry();

// Add default labels
register.setDefaultLabels({
  app: 'youtube-api',
});

// Collect default metrics (memory, CPU, etc.)
client.collectDefaultMetrics({ register });

// ============ HTTP Request Metrics ============

export const httpRequestsTotal: Counter<'method' | 'endpoint' | 'status_code'> = new Counter({
  name: 'http_requests_total',
  help: 'Total number of HTTP requests',
  labelNames: ['method', 'endpoint', 'status_code'] as const,
  registers: [register],
});

export const httpRequestDuration: Histogram<'method' | 'endpoint' | 'status_code'> = new Histogram({
  name: 'http_request_duration_seconds',
  help: 'Duration of HTTP requests in seconds',
  labelNames: ['method', 'endpoint', 'status_code'] as const,
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [register],
});

// ============ Business Metrics ============

// Video metrics
export const videoViewsTotal: Counter<'video_id' | 'channel_id'> = new Counter({
  name: 'video_views_total',
  help: 'Total number of video views',
  labelNames: ['video_id', 'channel_id'] as const,
  registers: [register],
});

export const videoWatchDuration: Histogram<'video_id'> = new Histogram({
  name: 'video_watch_duration_seconds',
  help: 'Video watch duration in seconds',
  labelNames: ['video_id'] as const,
  buckets: [10, 30, 60, 120, 300, 600, 1800, 3600],
  registers: [register],
});

export const videoUploadsTotal: Counter<'status'> = new Counter({
  name: 'video_uploads_total',
  help: 'Total number of video uploads',
  labelNames: ['status'] as const, // success, failed
  registers: [register],
});

export const videoUploadSize: Histogram<string> = new Histogram({
  name: 'video_upload_size_bytes',
  help: 'Size of uploaded videos in bytes',
  buckets: [
    1024 * 1024, // 1MB
    10 * 1024 * 1024, // 10MB
    50 * 1024 * 1024, // 50MB
    100 * 1024 * 1024, // 100MB
    500 * 1024 * 1024, // 500MB
    1024 * 1024 * 1024, // 1GB
  ],
  registers: [register],
});

// Transcoding metrics
export const transcodeQueueDepth: Gauge<string> = new Gauge({
  name: 'transcode_queue_depth',
  help: 'Current number of videos in the transcoding queue',
  registers: [register],
});

export const transcodeJobDuration: Histogram<'resolution' | 'status'> = new Histogram({
  name: 'transcode_job_duration_seconds',
  help: 'Duration of transcoding jobs in seconds',
  labelNames: ['resolution', 'status'] as const,
  buckets: [10, 30, 60, 120, 300, 600, 1800, 3600],
  registers: [register],
});

export const transcodedVideosTotal: Counter<'status' | 'resolution'> = new Counter({
  name: 'transcoded_videos_total',
  help: 'Total number of transcoded videos',
  labelNames: ['status', 'resolution'] as const,
  registers: [register],
});

// Engagement metrics
export const commentsTotal: Counter<'action'> = new Counter({
  name: 'comments_total',
  help: 'Total number of comments created',
  labelNames: ['action'] as const, // created, deleted
  registers: [register],
});

export const reactionsTotal: Counter<'type' | 'target'> = new Counter({
  name: 'reactions_total',
  help: 'Total number of reactions',
  labelNames: ['type', 'target'] as const, // like/dislike, video/comment
  registers: [register],
});

export const subscriptionsTotal: Counter<'action'> = new Counter({
  name: 'subscriptions_total',
  help: 'Total number of subscription events',
  labelNames: ['action'] as const, // subscribe, unsubscribe
  registers: [register],
});

// ============ System Health Metrics ============

// Database metrics
export const dbQueryDuration: Histogram<'query_type'> = new Histogram({
  name: 'db_query_duration_seconds',
  help: 'Duration of database queries in seconds',
  labelNames: ['query_type'] as const, // select, insert, update, delete
  buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 5],
  registers: [register],
});

export const dbConnectionPoolSize: Gauge<'state'> = new Gauge({
  name: 'db_connection_pool_size',
  help: 'Current size of the database connection pool',
  labelNames: ['state'] as const, // idle, active, waiting
  registers: [register],
});

// Cache metrics
export const cacheHitRatio: Gauge<'cache'> = new Gauge({
  name: 'cache_hit_ratio',
  help: 'Cache hit ratio (hits / total requests)',
  labelNames: ['cache'] as const, // session, video, channel
  registers: [register],
});

export const cacheOperationsTotal: Counter<'cache' | 'operation' | 'result'> = new Counter({
  name: 'cache_operations_total',
  help: 'Total cache operations',
  labelNames: ['cache', 'operation', 'result'] as const, // cache name, get/set/delete, hit/miss
  registers: [register],
});

// Storage metrics
export const storageOperationsTotal: Counter<'operation' | 'bucket' | 'status'> = new Counter({
  name: 'storage_operations_total',
  help: 'Total storage operations',
  labelNames: ['operation', 'bucket', 'status'] as const, // put/get/delete, bucket name, success/failure
  registers: [register],
});

export const storageOperationDuration: Histogram<'operation' | 'bucket'> = new Histogram({
  name: 'storage_operation_duration_seconds',
  help: 'Duration of storage operations in seconds',
  labelNames: ['operation', 'bucket'] as const,
  buckets: [0.1, 0.5, 1, 2, 5, 10, 30],
  registers: [register],
});

// Circuit breaker metrics
export const circuitBreakerState: Gauge<'service'> = new Gauge({
  name: 'circuit_breaker_state',
  help: 'Circuit breaker state (0=closed, 1=open, 2=half-open)',
  labelNames: ['service'] as const,
  registers: [register],
});

export const circuitBreakerFailuresTotal: Counter<'service'> = new Counter({
  name: 'circuit_breaker_failures_total',
  help: 'Total circuit breaker failures',
  labelNames: ['service'] as const,
  registers: [register],
});

// Rate limiting metrics
export const rateLimitHitsTotal: Counter<'endpoint' | 'type'> = new Counter({
  name: 'rate_limit_hits_total',
  help: 'Total number of rate limit hits',
  labelNames: ['endpoint', 'type'] as const, // endpoint, ip/user
  registers: [register],
});

// ============ Express Middleware ============

/**
 * Express middleware to track HTTP request metrics
 */
export const metricsMiddleware = (req: Request, res: Response, next: NextFunction): void => {
  const startTime = Date.now();

  res.on('finish', () => {
    const duration = (Date.now() - startTime) / 1000;
    const endpoint = normalizeEndpoint(req.route?.path || req.path);

    httpRequestsTotal.inc({
      method: req.method,
      endpoint,
      status_code: res.statusCode.toString(),
    });

    httpRequestDuration.observe(
      {
        method: req.method,
        endpoint,
        status_code: res.statusCode.toString(),
      },
      duration
    );
  });

  next();
};

/**
 * Normalize endpoint path for metrics (remove IDs)
 */
function normalizeEndpoint(path: string): string {
  return path
    .replace(/\/[a-f0-9-]{36}/gi, '/:id') // UUID
    .replace(/\/\d+/g, '/:id') // Numeric ID
    .replace(/\/[A-Za-z0-9_-]{11}/g, '/:id'); // YouTube-style ID
}

// ============ Metrics Endpoint Handler ============

/**
 * Handler for /metrics endpoint
 */
export const metricsHandler = async (req: Request, res: Response): Promise<void> => {
  try {
    res.set('Content-Type', register.contentType);
    res.end(await register.metrics());
  } catch (error) {
    res.status(500).end((error as Error).message);
  }
};

export { register };
export default register;
