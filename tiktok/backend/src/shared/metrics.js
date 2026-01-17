import client from 'prom-client';
import { createLogger } from './logger.js';

const logger = createLogger('metrics');

// Create a Registry for metrics
const register = new client.Registry();

// Add default metrics (CPU, memory, event loop lag, etc.)
client.collectDefaultMetrics({ register });

// Custom metrics for TikTok-specific operations

// Video views counter
export const videoViewsCounter = new client.Counter({
  name: 'tiktok_video_views_total',
  help: 'Total number of video views',
  labelNames: ['source'], // fyp, following, hashtag, search
  registers: [register],
});

// Video likes counter
export const videoLikesCounter = new client.Counter({
  name: 'tiktok_video_likes_total',
  help: 'Total number of video likes',
  registers: [register],
});

// Video shares counter
export const videoSharesCounter = new client.Counter({
  name: 'tiktok_video_shares_total',
  help: 'Total number of video shares',
  registers: [register],
});

// Video uploads counter
export const videoUploadsCounter = new client.Counter({
  name: 'tiktok_video_uploads_total',
  help: 'Total number of video uploads',
  labelNames: ['status'], // success, failure
  registers: [register],
});

// For You Page (FYP) latency histogram
export const fypLatencyHistogram = new client.Histogram({
  name: 'tiktok_fyp_latency_seconds',
  help: 'For You Page recommendation latency in seconds',
  labelNames: ['user_type'], // authenticated, anonymous
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [register],
});

// Recommendation service latency
export const recommendationLatencyHistogram = new client.Histogram({
  name: 'tiktok_recommendation_latency_seconds',
  help: 'Recommendation service latency in seconds',
  labelNames: ['phase'], // candidate_generation, ranking
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  registers: [register],
});

// Video processing latency
export const videoProcessingLatencyHistogram = new client.Histogram({
  name: 'tiktok_video_processing_latency_seconds',
  help: 'Video processing (transcoding) latency in seconds',
  labelNames: ['resolution'],
  buckets: [1, 5, 10, 30, 60, 120, 300, 600],
  registers: [register],
});

// HTTP request duration histogram
export const httpRequestDurationHistogram = new client.Histogram({
  name: 'tiktok_http_request_duration_seconds',
  help: 'Duration of HTTP requests in seconds',
  labelNames: ['method', 'route', 'status_code'],
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [register],
});

// Active sessions gauge
export const activeSessionsGauge = new client.Gauge({
  name: 'tiktok_active_sessions',
  help: 'Number of active user sessions',
  registers: [register],
});

// Circuit breaker state gauge
export const circuitBreakerStateGauge = new client.Gauge({
  name: 'tiktok_circuit_breaker_state',
  help: 'Circuit breaker state (0=closed, 1=half-open, 2=open)',
  labelNames: ['service'],
  registers: [register],
});

// Rate limit hits counter
export const rateLimitHitsCounter = new client.Counter({
  name: 'tiktok_rate_limit_hits_total',
  help: 'Total number of rate limit hits',
  labelNames: ['endpoint', 'user_type'],
  registers: [register],
});

// Database query duration histogram
export const dbQueryDurationHistogram = new client.Histogram({
  name: 'tiktok_db_query_duration_seconds',
  help: 'Database query duration in seconds',
  labelNames: ['operation'], // select, insert, update, delete
  buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 5],
  registers: [register],
});

// Redis operation duration histogram
export const redisOperationDurationHistogram = new client.Histogram({
  name: 'tiktok_redis_operation_duration_seconds',
  help: 'Redis operation duration in seconds',
  labelNames: ['operation'],
  buckets: [0.0001, 0.0005, 0.001, 0.005, 0.01, 0.05, 0.1],
  registers: [register],
});

// Storage operation duration histogram
export const storageOperationDurationHistogram = new client.Histogram({
  name: 'tiktok_storage_operation_duration_seconds',
  help: 'Object storage operation duration in seconds',
  labelNames: ['operation'], // upload, download, delete
  buckets: [0.1, 0.5, 1, 5, 10, 30, 60],
  registers: [register],
});

// Middleware to track HTTP request duration
export const metricsMiddleware = (req, res, next) => {
  const start = process.hrtime.bigint();

  res.on('finish', () => {
    const end = process.hrtime.bigint();
    const durationSeconds = Number(end - start) / 1e9;

    // Extract route pattern (e.g., /api/videos/:id instead of /api/videos/123)
    const route = req.route?.path || req.path || 'unknown';
    const baseRoute = req.baseUrl + route;

    httpRequestDurationHistogram
      .labels(req.method, baseRoute, res.statusCode.toString())
      .observe(durationSeconds);
  });

  next();
};

// Get metrics for /metrics endpoint
export const getMetrics = async () => {
  return await register.metrics();
};

// Get content type for /metrics endpoint
export const getContentType = () => {
  return register.contentType;
};

// Helper to time async operations
export const timeAsync = async (histogram, labels, fn) => {
  const start = process.hrtime.bigint();
  try {
    return await fn();
  } finally {
    const end = process.hrtime.bigint();
    const durationSeconds = Number(end - start) / 1e9;
    histogram.labels(labels).observe(durationSeconds);
  }
};

logger.info('Prometheus metrics initialized');

export default register;
