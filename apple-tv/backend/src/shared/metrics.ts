/**
 * Prometheus metrics for Apple TV+ streaming service
 *
 * Provides comprehensive metrics for:
 * - HTTP request latency and throughput
 * - Streaming-specific metrics (playback start latency, active streams)
 * - CDN performance (cache hits/misses)
 * - DRM license operations
 * - Transcoding job tracking
 * - Circuit breaker states
 */
import promClient, { Registry, Histogram, Counter, Gauge } from 'prom-client';
import { Request, Response, NextFunction } from 'express';

// Create a Registry to register metrics
export const register: Registry = new promClient.Registry();

// Add default metrics (CPU, memory, etc.)
promClient.collectDefaultMetrics({ register });

// ============================================
// HTTP Request Metrics
// ============================================

export const httpRequestDuration: Histogram<string> = new promClient.Histogram({
  name: 'http_request_duration_seconds',
  help: 'Duration of HTTP requests in seconds',
  labelNames: ['method', 'route', 'status_code'],
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [register]
});

export const httpRequestTotal: Counter<string> = new promClient.Counter({
  name: 'http_requests_total',
  help: 'Total number of HTTP requests',
  labelNames: ['method', 'route', 'status_code'],
  registers: [register]
});

// ============================================
// Streaming Metrics
// ============================================

export const playbackStartLatency: Histogram<string> = new promClient.Histogram({
  name: 'playback_start_latency_seconds',
  help: 'Time from play request to first frame rendered',
  labelNames: ['device_type', 'quality'],
  buckets: [0.5, 1, 1.5, 2, 2.5, 3, 5, 10],
  registers: [register]
});

export const activeStreams: Gauge<string> = new promClient.Gauge({
  name: 'active_streams_total',
  help: 'Number of currently active video streams',
  labelNames: ['quality', 'device_type'],
  registers: [register]
});

export const manifestGenerationDuration: Histogram<string> = new promClient.Histogram({
  name: 'manifest_generation_duration_seconds',
  help: 'Duration of HLS manifest generation',
  labelNames: ['manifest_type'], // master, variant, audio, subtitle
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5],
  registers: [register]
});

export const segmentRequestsTotal: Counter<string> = new promClient.Counter({
  name: 'segment_requests_total',
  help: 'Total number of segment requests',
  labelNames: ['content_id', 'quality'],
  registers: [register]
});

export const streamingErrors: Counter<string> = new promClient.Counter({
  name: 'streaming_errors_total',
  help: 'Total number of streaming errors',
  labelNames: ['error_type', 'content_id'],
  registers: [register]
});

// ============================================
// CDN Metrics
// ============================================

export const cdnCacheHits: Counter<string> = new promClient.Counter({
  name: 'cdn_cache_hits_total',
  help: 'CDN cache hit count',
  labelNames: ['edge_location', 'content_type'],
  registers: [register]
});

export const cdnCacheMisses: Counter<string> = new promClient.Counter({
  name: 'cdn_cache_misses_total',
  help: 'CDN cache miss count',
  labelNames: ['edge_location', 'content_type'],
  registers: [register]
});

// ============================================
// DRM Metrics
// ============================================

export const drmLicenseRequests: Counter<string> = new promClient.Counter({
  name: 'drm_license_requests_total',
  help: 'Total DRM license requests',
  labelNames: ['status', 'device_type'],
  registers: [register]
});

export const drmLicenseLatency: Histogram<string> = new promClient.Histogram({
  name: 'drm_license_latency_seconds',
  help: 'DRM license issuance latency',
  labelNames: ['device_type'],
  buckets: [0.05, 0.1, 0.2, 0.3, 0.5, 1],
  registers: [register]
});

// ============================================
// Transcoding Metrics
// ============================================

export const transcodingJobDuration: Histogram<string> = new promClient.Histogram({
  name: 'transcoding_job_duration_seconds',
  help: 'Duration of transcoding jobs',
  labelNames: ['resolution', 'codec'],
  buckets: [60, 300, 600, 1800, 3600, 7200],
  registers: [register]
});

export const transcodingJobsTotal: Counter<string> = new promClient.Counter({
  name: 'transcoding_jobs_total',
  help: 'Total transcoding jobs',
  labelNames: ['resolution', 'codec', 'status'],
  registers: [register]
});

// ============================================
// Circuit Breaker Metrics
// ============================================

export const circuitBreakerState: Gauge<string> = new promClient.Gauge({
  name: 'circuit_breaker_state',
  help: 'Circuit breaker state (0=closed, 1=half-open, 2=open)',
  labelNames: ['service'],
  registers: [register]
});

export const circuitBreakerFailures: Counter<string> = new promClient.Counter({
  name: 'circuit_breaker_failures_total',
  help: 'Total circuit breaker failures',
  labelNames: ['service'],
  registers: [register]
});

export const circuitBreakerSuccesses: Counter<string> = new promClient.Counter({
  name: 'circuit_breaker_successes_total',
  help: 'Total circuit breaker successes',
  labelNames: ['service'],
  registers: [register]
});

// ============================================
// Watch Progress Metrics
// ============================================

export const watchProgressUpdates: Counter<string> = new promClient.Counter({
  name: 'watch_progress_updates_total',
  help: 'Total watch progress updates',
  labelNames: ['status'], // success, conflict, error
  registers: [register]
});

export const idempotentRequestsTotal: Counter<string> = new promClient.Counter({
  name: 'idempotent_requests_total',
  help: 'Total idempotent requests',
  labelNames: ['result'], // new, cached, in_progress
  registers: [register]
});

// ============================================
// Express Middleware
// ============================================

/**
 * Express middleware to track HTTP request metrics
 */
export function metricsMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const start = process.hrtime.bigint();

  res.on('finish', () => {
    const duration = Number(process.hrtime.bigint() - start) / 1e9;
    const route = req.route?.path || req.path;
    const labels = {
      method: req.method,
      route: route,
      status_code: res.statusCode.toString()
    };

    httpRequestDuration.observe(labels, duration);
    httpRequestTotal.inc(labels);
  });

  next();
}

/**
 * Get metrics endpoint handler
 */
export async function metricsHandler(req: Request, res: Response): Promise<void> {
  try {
    res.set('Content-Type', register.contentType);
    res.end(await register.metrics());
  } catch (error) {
    res.status(500).end((error as Error).message);
  }
}
