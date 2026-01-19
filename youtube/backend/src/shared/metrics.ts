import client from 'prom-client';

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
const register = new client.Registry();

// Add default labels
register.setDefaultLabels({
  app: 'youtube-api',
});

// Collect default metrics (memory, CPU, etc.)
client.collectDefaultMetrics({ register });

// ============ HTTP Request Metrics ============

export const httpRequestsTotal = new client.Counter({
  name: 'http_requests_total',
  help: 'Total number of HTTP requests',
  labelNames: ['method', 'endpoint', 'status_code'],
  registers: [register],
});

export const httpRequestDuration = new client.Histogram({
  name: 'http_request_duration_seconds',
  help: 'Duration of HTTP requests in seconds',
  labelNames: ['method', 'endpoint', 'status_code'],
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [register],
});

// ============ Business Metrics ============

// Video metrics
export const videoViewsTotal = new client.Counter({
  name: 'video_views_total',
  help: 'Total number of video views',
  labelNames: ['video_id', 'channel_id'],
  registers: [register],
});

export const videoWatchDuration = new client.Histogram({
  name: 'video_watch_duration_seconds',
  help: 'Video watch duration in seconds',
  labelNames: ['video_id'],
  buckets: [10, 30, 60, 120, 300, 600, 1800, 3600],
  registers: [register],
});

export const videoUploadsTotal = new client.Counter({
  name: 'video_uploads_total',
  help: 'Total number of video uploads',
  labelNames: ['status'], // success, failed
  registers: [register],
});

export const videoUploadSize = new client.Histogram({
  name: 'video_upload_size_bytes',
  help: 'Size of uploaded videos in bytes',
  buckets: [
    1024 * 1024,      // 1MB
    10 * 1024 * 1024, // 10MB
    50 * 1024 * 1024, // 50MB
    100 * 1024 * 1024, // 100MB
    500 * 1024 * 1024, // 500MB
    1024 * 1024 * 1024, // 1GB
  ],
  registers: [register],
});

// Transcoding metrics
export const transcodeQueueDepth = new client.Gauge({
  name: 'transcode_queue_depth',
  help: 'Current number of videos in the transcoding queue',
  registers: [register],
});

export const transcodeJobDuration = new client.Histogram({
  name: 'transcode_job_duration_seconds',
  help: 'Duration of transcoding jobs in seconds',
  labelNames: ['resolution', 'status'],
  buckets: [10, 30, 60, 120, 300, 600, 1800, 3600],
  registers: [register],
});

export const transcodedVideosTotal = new client.Counter({
  name: 'transcoded_videos_total',
  help: 'Total number of transcoded videos',
  labelNames: ['status', 'resolution'],
  registers: [register],
});

// Engagement metrics
export const commentsTotal = new client.Counter({
  name: 'comments_total',
  help: 'Total number of comments created',
  labelNames: ['action'], // created, deleted
  registers: [register],
});

export const reactionsTotal = new client.Counter({
  name: 'reactions_total',
  help: 'Total number of reactions',
  labelNames: ['type', 'target'], // like/dislike, video/comment
  registers: [register],
});

export const subscriptionsTotal = new client.Counter({
  name: 'subscriptions_total',
  help: 'Total number of subscription events',
  labelNames: ['action'], // subscribe, unsubscribe
  registers: [register],
});

// ============ System Health Metrics ============

// Database metrics
export const dbQueryDuration = new client.Histogram({
  name: 'db_query_duration_seconds',
  help: 'Duration of database queries in seconds',
  labelNames: ['query_type'], // select, insert, update, delete
  buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 5],
  registers: [register],
});

export const dbConnectionPoolSize = new client.Gauge({
  name: 'db_connection_pool_size',
  help: 'Current size of the database connection pool',
  labelNames: ['state'], // idle, active, waiting
  registers: [register],
});

// Cache metrics
export const cacheHitRatio = new client.Gauge({
  name: 'cache_hit_ratio',
  help: 'Cache hit ratio (hits / total requests)',
  labelNames: ['cache'], // session, video, channel
  registers: [register],
});

export const cacheOperationsTotal = new client.Counter({
  name: 'cache_operations_total',
  help: 'Total cache operations',
  labelNames: ['cache', 'operation', 'result'], // cache name, get/set/delete, hit/miss
  registers: [register],
});

// Storage metrics
export const storageOperationsTotal = new client.Counter({
  name: 'storage_operations_total',
  help: 'Total storage operations',
  labelNames: ['operation', 'bucket', 'status'], // put/get/delete, bucket name, success/failure
  registers: [register],
});

export const storageOperationDuration = new client.Histogram({
  name: 'storage_operation_duration_seconds',
  help: 'Duration of storage operations in seconds',
  labelNames: ['operation', 'bucket'],
  buckets: [0.1, 0.5, 1, 2, 5, 10, 30],
  registers: [register],
});

// Circuit breaker metrics
export const circuitBreakerState = new client.Gauge({
  name: 'circuit_breaker_state',
  help: 'Circuit breaker state (0=closed, 1=open, 2=half-open)',
  labelNames: ['service'],
  registers: [register],
});

export const circuitBreakerFailuresTotal = new client.Counter({
  name: 'circuit_breaker_failures_total',
  help: 'Total circuit breaker failures',
  labelNames: ['service'],
  registers: [register],
});

// Rate limiting metrics
export const rateLimitHitsTotal = new client.Counter({
  name: 'rate_limit_hits_total',
  help: 'Total number of rate limit hits',
  labelNames: ['endpoint', 'type'], // endpoint, ip/user
  registers: [register],
});

// ============ Express Middleware ============

/**
 * Express middleware to track HTTP request metrics
 */
export const metricsMiddleware = (req, res, next) => {
  const startTime = Date.now();

  res.on('finish', () => {
    const duration = (Date.now() - startTime) / 1000;
    const endpoint = normalizeEndpoint(req.route?.path || req.path);

    httpRequestsTotal.inc({
      method: req.method,
      endpoint,
      status_code: res.statusCode,
    });

    httpRequestDuration.observe(
      {
        method: req.method,
        endpoint,
        status_code: res.statusCode,
      },
      duration
    );
  });

  next();
};

/**
 * Normalize endpoint path for metrics (remove IDs)
 */
function normalizeEndpoint(path) {
  return path
    .replace(/\/[a-f0-9-]{36}/gi, '/:id')  // UUID
    .replace(/\/\d+/g, '/:id')              // Numeric ID
    .replace(/\/[A-Za-z0-9_-]{11}/g, '/:id'); // YouTube-style ID
}

// ============ Metrics Endpoint Handler ============

/**
 * Handler for /metrics endpoint
 */
export const metricsHandler = async (req, res) => {
  try {
    res.set('Content-Type', register.contentType);
    res.end(await register.metrics());
  } catch (error) {
    res.status(500).end(error.message);
  }
};

export { register };
export default register;
