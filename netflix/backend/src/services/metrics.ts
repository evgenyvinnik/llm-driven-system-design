/**
 * Prometheus Metrics Module.
 *
 * Provides application metrics for monitoring and alerting.
 * Exposes a /metrics endpoint compatible with Prometheus scraping.
 *
 * Key Metrics:
 * - HTTP request duration and count
 * - Streaming events (starts, buffer events, playback errors)
 * - Circuit breaker state changes
 * - Database connection pool status
 * - Cache hit/miss rates
 */
import { Registry, Counter, Histogram, Gauge, collectDefaultMetrics } from 'prom-client';
import { Request, Response, NextFunction } from 'express';

/**
 * Custom registry for application metrics.
 * Using a custom registry allows for isolated testing and multiple registries.
 */
export const metricsRegistry = new Registry();

// Collect default Node.js metrics (memory, CPU, event loop, etc.)
collectDefaultMetrics({ register: metricsRegistry });

// =========================================================
// HTTP Metrics
// =========================================================

/**
 * HTTP request duration histogram.
 * Tracks request latency by method, route, and status code.
 */
export const httpRequestDuration = new Histogram({
  name: 'http_request_duration_seconds',
  help: 'Duration of HTTP requests in seconds',
  labelNames: ['method', 'route', 'status_code'],
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [metricsRegistry],
});

/**
 * HTTP request counter.
 * Tracks total requests by method, route, and status code.
 */
export const httpRequestsTotal = new Counter({
  name: 'http_requests_total',
  help: 'Total number of HTTP requests',
  labelNames: ['method', 'route', 'status_code'],
  registers: [metricsRegistry],
});

// =========================================================
// Streaming Metrics (QoE - Quality of Experience)
// =========================================================

/**
 * Stream start events counter.
 * Tracks successful playback initiations by quality level.
 */
export const streamingStarts = new Counter({
  name: 'streaming_starts_total',
  help: 'Total number of streaming starts',
  labelNames: ['quality', 'content_type'],
  registers: [metricsRegistry],
});

/**
 * Buffer events counter.
 * Tracks buffering events that impact user experience.
 */
export const bufferEvents = new Counter({
  name: 'streaming_buffer_events_total',
  help: 'Total number of buffer events during playback',
  labelNames: ['quality', 'content_type'],
  registers: [metricsRegistry],
});

/**
 * Playback error counter.
 * Tracks errors during video playback by error type.
 */
export const playbackErrors = new Counter({
  name: 'streaming_playback_errors_total',
  help: 'Total number of playback errors',
  labelNames: ['error_type', 'content_type'],
  registers: [metricsRegistry],
});

/**
 * Bitrate histogram.
 * Tracks the bitrate distribution of video playback.
 */
export const streamingBitrate = new Histogram({
  name: 'streaming_bitrate_kbps',
  help: 'Video streaming bitrate in kbps',
  labelNames: ['quality'],
  buckets: [235, 560, 1050, 2350, 4300, 5800, 15000],
  registers: [metricsRegistry],
});

/**
 * Active streams gauge.
 * Tracks currently active streaming sessions.
 */
export const activeStreams = new Gauge({
  name: 'streaming_active_sessions',
  help: 'Number of currently active streaming sessions',
  registers: [metricsRegistry],
});

// =========================================================
// Circuit Breaker Metrics
// =========================================================

/**
 * Circuit breaker state gauge.
 * 0 = CLOSED, 1 = HALF_OPEN, 2 = OPEN
 */
export const circuitBreakerState = new Gauge({
  name: 'circuit_breaker_state',
  help: 'Current state of circuit breaker (0=closed, 1=half_open, 2=open)',
  labelNames: ['service'],
  registers: [metricsRegistry],
});

/**
 * Circuit breaker failure counter.
 */
export const circuitBreakerFailures = new Counter({
  name: 'circuit_breaker_failures_total',
  help: 'Total number of circuit breaker failures',
  labelNames: ['service'],
  registers: [metricsRegistry],
});

/**
 * Circuit breaker success counter.
 */
export const circuitBreakerSuccesses = new Counter({
  name: 'circuit_breaker_successes_total',
  help: 'Total number of successful calls through circuit breaker',
  labelNames: ['service'],
  registers: [metricsRegistry],
});

// =========================================================
// Database Metrics
// =========================================================

/**
 * Database query duration histogram.
 */
export const dbQueryDuration = new Histogram({
  name: 'db_query_duration_seconds',
  help: 'Duration of database queries in seconds',
  labelNames: ['operation'],
  buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1],
  registers: [metricsRegistry],
});

/**
 * Database connection pool gauge.
 */
export const dbPoolConnections = new Gauge({
  name: 'db_pool_connections',
  help: 'Number of database pool connections',
  labelNames: ['state'],
  registers: [metricsRegistry],
});

// =========================================================
// Cache Metrics
// =========================================================

/**
 * Cache hit/miss counter.
 */
export const cacheOperations = new Counter({
  name: 'cache_operations_total',
  help: 'Total cache operations',
  labelNames: ['operation', 'result'],
  registers: [metricsRegistry],
});

// =========================================================
// Rate Limiting Metrics
// =========================================================

/**
 * Rate limit exceeded counter.
 */
export const rateLimitExceeded = new Counter({
  name: 'rate_limit_exceeded_total',
  help: 'Total number of rate limit exceeded responses',
  labelNames: ['endpoint_category'],
  registers: [metricsRegistry],
});

// =========================================================
// Background Job Metrics
// =========================================================

/**
 * Background job execution counter.
 */
export const jobExecutions = new Counter({
  name: 'background_job_executions_total',
  help: 'Total number of background job executions',
  labelNames: ['job_name', 'status'],
  registers: [metricsRegistry],
});

/**
 * Background job duration histogram.
 */
export const jobDuration = new Histogram({
  name: 'background_job_duration_seconds',
  help: 'Duration of background job executions',
  labelNames: ['job_name'],
  buckets: [0.1, 0.5, 1, 5, 10, 30, 60, 120],
  registers: [metricsRegistry],
});

// =========================================================
// Middleware and Helpers
// =========================================================

/**
 * Express middleware for tracking HTTP metrics.
 * Tracks request duration and count by method, route, and status code.
 */
export function metricsMiddleware(req: Request, res: Response, next: NextFunction): void {
  const startTime = Date.now();

  res.on('finish', () => {
    const duration = (Date.now() - startTime) / 1000;
    const route = getRoutePattern(req);
    const method = req.method;
    const statusCode = res.statusCode.toString();

    httpRequestDuration.labels(method, route, statusCode).observe(duration);
    httpRequestsTotal.labels(method, route, statusCode).inc();
  });

  next();
}

/**
 * Extracts route pattern from request.
 * Normalizes dynamic parameters to avoid high cardinality.
 *
 * @param req - Express request object
 * @returns Normalized route pattern
 */
function getRoutePattern(req: Request): string {
  // Use Express route pattern if available
  if (req.route && req.route.path) {
    const basePath = req.baseUrl || '';
    return `${basePath}${req.route.path}`;
  }

  // Fallback: normalize common ID patterns
  return req.path
    .replace(/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '/:id')
    .replace(/\/\d+/g, '/:id');
}

/**
 * Returns metrics in Prometheus format.
 * Used by the /metrics endpoint.
 */
export async function getMetrics(): Promise<string> {
  return metricsRegistry.metrics();
}

/**
 * Returns metrics content type for HTTP response.
 */
export function getMetricsContentType(): string {
  return metricsRegistry.contentType;
}

// =========================================================
// Streaming Metric Helpers
// =========================================================

/**
 * Records a streaming start event.
 */
export function recordStreamingStart(quality: string, contentType: 'movie' | 'episode'): void {
  streamingStarts.labels(quality, contentType).inc();
  activeStreams.inc();
}

/**
 * Records a streaming end event.
 */
export function recordStreamingEnd(): void {
  activeStreams.dec();
}

/**
 * Records a buffer event during playback.
 */
export function recordBufferEvent(quality: string, contentType: 'movie' | 'episode'): void {
  bufferEvents.labels(quality, contentType).inc();
}

/**
 * Records a playback error.
 */
export function recordPlaybackError(errorType: string, contentType: 'movie' | 'episode'): void {
  playbackErrors.labels(errorType, contentType).inc();
}

/**
 * Records current streaming bitrate.
 */
export function recordStreamingBitrate(quality: string, bitrateKbps: number): void {
  streamingBitrate.labels(quality).observe(bitrateKbps);
}
