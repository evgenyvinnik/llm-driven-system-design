/**
 * Prometheus metrics module for observability.
 * Provides pre-configured metrics and an Express endpoint for Prometheus scraping.
 *
 * WHY: Metrics provide visibility into system health and performance. Prometheus
 * metrics enable alerting on anomalies (high error rates, slow responses) and
 * capacity planning (request volumes, resource usage). Without metrics, debugging
 * production issues becomes guesswork.
 *
 * @module shared/metrics
 */

import { Request, Response, NextFunction } from 'express'
import client from 'prom-client'

// Create a Registry to register metrics
const register = new client.Registry()

// Add default labels
register.setDefaultLabels({
  app: 'scale-ai',
})

// Collect default metrics (CPU, memory, event loop, etc.)
client.collectDefaultMetrics({ register })

// ============================================================================
// HTTP Request Metrics
// ============================================================================

/**
 * Counter for total HTTP requests.
 * Labels: method, route, status_code
 */
export const httpRequestsTotal = new client.Counter({
  name: 'http_requests_total',
  help: 'Total number of HTTP requests',
  labelNames: ['method', 'route', 'status_code'],
  registers: [register],
})

/**
 * Histogram for HTTP request duration.
 * Labels: method, route, status_code
 * Buckets optimized for API latencies.
 */
export const httpRequestDuration = new client.Histogram({
  name: 'http_request_duration_seconds',
  help: 'HTTP request duration in seconds',
  labelNames: ['method', 'route', 'status_code'],
  buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [register],
})

/**
 * Gauge for in-flight requests.
 * Labels: method, route
 */
export const httpRequestsInFlight = new client.Gauge({
  name: 'http_requests_in_flight',
  help: 'Number of HTTP requests currently in flight',
  labelNames: ['method', 'route'],
  registers: [register],
})

// ============================================================================
// Business Metrics
// ============================================================================

/**
 * Counter for drawing submissions.
 * Labels: shape, status (success, error)
 */
export const drawingsTotal = new client.Counter({
  name: 'drawings_total',
  help: 'Total number of drawing submissions',
  labelNames: ['shape', 'status'],
  registers: [register],
})

/**
 * Histogram for drawing processing duration.
 * Labels: shape
 */
export const drawingProcessingDuration = new client.Histogram({
  name: 'drawing_processing_duration_seconds',
  help: 'Time to process a drawing submission',
  labelNames: ['shape'],
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 5],
  registers: [register],
})

/**
 * Counter for training jobs.
 * Labels: status (queued, running, completed, failed)
 */
export const trainingJobsTotal = new client.Counter({
  name: 'training_jobs_total',
  help: 'Total number of training jobs',
  labelNames: ['status'],
  registers: [register],
})

/**
 * Counter for inference requests.
 * Labels: model_version, predicted_shape
 */
export const inferenceRequestsTotal = new client.Counter({
  name: 'inference_requests_total',
  help: 'Total number of inference requests',
  labelNames: ['model_version', 'predicted_shape'],
  registers: [register],
})

/**
 * Histogram for inference latency.
 * Labels: model_version
 */
export const inferenceLatency = new client.Histogram({
  name: 'inference_latency_seconds',
  help: 'Inference latency in seconds',
  labelNames: ['model_version'],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1],
  registers: [register],
})

/**
 * Counter for shape generation requests.
 * Labels: model_version, shape
 */
export const generationRequestsTotal = new client.Counter({
  name: 'generation_requests_total',
  help: 'Total number of shape generation requests',
  labelNames: ['model_version', 'shape'],
  registers: [register],
})

/**
 * Histogram for generation latency.
 * Labels: model_version
 */
export const generationLatency = new client.Histogram({
  name: 'generation_latency_seconds',
  help: 'Shape generation latency in seconds',
  labelNames: ['model_version'],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1],
  registers: [register],
})

// ============================================================================
// External Service Metrics
// ============================================================================

/**
 * Counter for external service calls.
 * Labels: service (minio, postgres, rabbitmq, redis), operation, status
 */
export const externalServiceCalls = new client.Counter({
  name: 'external_service_calls_total',
  help: 'Total number of calls to external services',
  labelNames: ['service', 'operation', 'status'],
  registers: [register],
})

/**
 * Histogram for external service latency.
 * Labels: service, operation
 */
export const externalServiceLatency = new client.Histogram({
  name: 'external_service_latency_seconds',
  help: 'Latency of external service calls',
  labelNames: ['service', 'operation'],
  buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  registers: [register],
})

/**
 * Gauge for circuit breaker states.
 * Labels: service
 * Values: 0 = closed, 1 = half-open, 2 = open
 */
export const circuitBreakerState = new client.Gauge({
  name: 'circuit_breaker_state',
  help: 'Circuit breaker state (0=closed, 1=half-open, 2=open)',
  labelNames: ['service'],
  registers: [register],
})

// ============================================================================
// Idempotency Metrics
// ============================================================================

/**
 * Counter for idempotency cache hits.
 * Labels: operation
 */
export const idempotencyCacheHits = new client.Counter({
  name: 'idempotency_cache_hits_total',
  help: 'Number of idempotent requests that returned cached responses',
  labelNames: ['operation'],
  registers: [register],
})

/**
 * Counter for idempotency cache misses.
 * Labels: operation
 */
export const idempotencyCacheMisses = new client.Counter({
  name: 'idempotency_cache_misses_total',
  help: 'Number of requests that were processed fresh',
  labelNames: ['operation'],
  registers: [register],
})

// ============================================================================
// Data Lifecycle Metrics
// ============================================================================

/**
 * Gauge for total drawings by age tier.
 * Labels: tier (hot, warm, archive)
 */
export const drawingsByTier = new client.Gauge({
  name: 'drawings_by_tier',
  help: 'Number of drawings by storage tier',
  labelNames: ['tier'],
  registers: [register],
})

/**
 * Counter for drawings cleaned up.
 * Labels: reason (age, flagged, deleted)
 */
export const drawingsCleanedUp = new client.Counter({
  name: 'drawings_cleaned_up_total',
  help: 'Number of drawings cleaned up',
  labelNames: ['reason'],
  registers: [register],
})

// ============================================================================
// Express Middleware
// ============================================================================

/**
 * Express middleware for automatically tracking HTTP metrics.
 * Measures request duration, counts requests, and tracks in-flight requests.
 *
 * @returns Express middleware function
 *
 * @example
 * ```typescript
 * app.use(metricsMiddleware())
 * ```
 */
export function metricsMiddleware(): (req: Request, res: Response, next: NextFunction) => void {
  return (req: Request, res: Response, next: NextFunction) => {
    // Skip metrics endpoint itself
    if (req.path === '/metrics') {
      next()
      return
    }

    const route = getRoutePattern(req)
    const method = req.method

    // Track in-flight requests
    httpRequestsInFlight.labels(method, route).inc()
    const endTimer = httpRequestDuration.startTimer({ method, route })

    // On response finish
    res.on('finish', () => {
      const statusCode = res.statusCode.toString()

      httpRequestsTotal.labels(method, route, statusCode).inc()
      endTimer({ status_code: statusCode })
      httpRequestsInFlight.labels(method, route).dec()
    })

    next()
  }
}

/**
 * Extracts a route pattern from a request for metric labeling.
 * Replaces dynamic segments (UUIDs, IDs) with placeholders.
 *
 * @param req - Express request object
 * @returns Route pattern string
 */
function getRoutePattern(req: Request): string {
  let route = req.route?.path || req.path

  // Replace common dynamic segments
  route = route.replace(/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '/:id')
  route = route.replace(/\/\d+/g, '/:id')

  return route
}

/**
 * Express handler for the /metrics endpoint.
 * Returns Prometheus-formatted metrics for scraping.
 *
 * @example
 * ```typescript
 * app.get('/metrics', metricsHandler)
 * ```
 */
export async function metricsHandler(_req: Request, res: Response): Promise<void> {
  try {
    res.set('Content-Type', register.contentType)
    res.end(await register.metrics())
  } catch (err) {
    res.status(500).end(err instanceof Error ? err.message : 'Failed to get metrics')
  }
}

/**
 * Returns the Prometheus registry for advanced usage.
 */
export { register }

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Records an external service call with timing and status.
 *
 * @param service - Service name (minio, postgres, rabbitmq, redis)
 * @param operation - Operation name (e.g., 'putObject', 'query')
 * @param fn - Function to execute and measure
 * @returns Promise resolving to the function's result
 */
export async function trackExternalCall<T>(
  service: string,
  operation: string,
  fn: () => Promise<T>
): Promise<T> {
  const endTimer = externalServiceLatency.startTimer({ service, operation })

  try {
    const result = await fn()
    endTimer()
    externalServiceCalls.labels(service, operation, 'success').inc()
    return result
  } catch (error) {
    endTimer()
    externalServiceCalls.labels(service, operation, 'error').inc()
    throw error
  }
}

/**
 * Updates circuit breaker state metric.
 *
 * @param service - Service name
 * @param state - Current state ('closed', 'half-open', 'open')
 */
export function updateCircuitBreakerMetric(
  service: string,
  state: 'closed' | 'half-open' | 'open'
): void {
  const stateValue = state === 'closed' ? 0 : state === 'half-open' ? 1 : 2
  circuitBreakerState.labels(service).set(stateValue)
}
