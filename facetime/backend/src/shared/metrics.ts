/**
 * Prometheus metrics for FaceTime signaling server.
 *
 * Exposes call quality, connection latency, and operational metrics
 * for SLI dashboards and alerting. These metrics enable:
 * - Call quality optimization through codec selection
 * - Capacity planning via connection tracking
 * - Proactive alerting on degradation
 */

import promClient from 'prom-client';

// Enable default metrics (CPU, memory, event loop, etc.)
promClient.collectDefaultMetrics({
  prefix: 'facetime_',
  labels: { service: 'signaling' },
});

// ============================================================================
// Call Metrics
// ============================================================================

/**
 * Total number of calls initiated.
 * Used to calculate call success rate.
 */
export const callsInitiated = new promClient.Counter({
  name: 'facetime_calls_initiated_total',
  help: 'Total number of calls initiated',
  labelNames: ['call_type'] as const,
});

/**
 * Total number of calls answered.
 * Used to calculate call success rate.
 */
export const callsAnswered = new promClient.Counter({
  name: 'facetime_calls_answered_total',
  help: 'Total number of calls answered',
  labelNames: ['call_type'] as const,
});

/**
 * Total number of calls ended by reason.
 */
export const callsEnded = new promClient.Counter({
  name: 'facetime_calls_ended_total',
  help: 'Total number of calls ended by reason',
  labelNames: ['call_type', 'reason'] as const,
});

/**
 * Duration of completed calls in seconds.
 * Buckets cover typical call durations from 30s to 1 hour.
 */
export const callDuration = new promClient.Histogram({
  name: 'facetime_call_duration_seconds',
  help: 'Duration of completed calls in seconds',
  labelNames: ['call_type'] as const,
  buckets: [30, 60, 120, 300, 600, 1800, 3600],
});

/**
 * Time from call initiation to connection.
 * Critical SLI for user experience.
 */
export const callSetupLatency = new promClient.Histogram({
  name: 'facetime_call_setup_latency_seconds',
  help: 'Time from initiation to connection',
  labelNames: ['call_type'] as const,
  buckets: [0.5, 1, 2, 3, 5, 10, 30],
});

/**
 * Current number of active calls.
 */
export const activeCalls = new promClient.Gauge({
  name: 'facetime_active_calls',
  help: 'Current number of active calls',
  labelNames: ['call_type'] as const,
});

// ============================================================================
// Connection Metrics
// ============================================================================

/**
 * Current number of active WebSocket connections.
 */
export const activeConnections = new promClient.Gauge({
  name: 'facetime_active_websocket_connections',
  help: 'Current number of active WebSocket connections',
});

/**
 * Total WebSocket connections established.
 */
export const connectionsTotal = new promClient.Counter({
  name: 'facetime_websocket_connections_total',
  help: 'Total WebSocket connections established',
});

/**
 * WebSocket connection errors by type.
 */
export const connectionErrors = new promClient.Counter({
  name: 'facetime_websocket_errors_total',
  help: 'WebSocket connection errors',
  labelNames: ['error_type'] as const,
});

// ============================================================================
// ICE/TURN Metrics (for call quality optimization)
// ============================================================================

/**
 * ICE connection types used.
 * High relay rate indicates NAT traversal issues.
 */
export const iceConnectionType = new promClient.Counter({
  name: 'facetime_ice_connection_type_total',
  help: 'ICE connection types used',
  labelNames: ['type'] as const,
});

/**
 * ICE candidate gathering latency.
 */
export const iceCandidateLatency = new promClient.Histogram({
  name: 'facetime_ice_candidate_latency_seconds',
  help: 'Time to gather ICE candidates',
  buckets: [0.1, 0.25, 0.5, 1, 2, 5],
});

// ============================================================================
// Signaling Metrics
// ============================================================================

/**
 * Signaling message processing latency.
 */
export const signalingLatency = new promClient.Histogram({
  name: 'facetime_signaling_latency_seconds',
  help: 'Signaling message processing latency',
  labelNames: ['message_type'] as const,
  buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1],
});

/**
 * Signaling errors by type.
 */
export const signalingErrors = new promClient.Counter({
  name: 'facetime_signaling_errors_total',
  help: 'Signaling errors by type',
  labelNames: ['error_type'] as const,
});

// ============================================================================
// Idempotency Metrics
// ============================================================================

/**
 * Idempotency key cache hits (duplicate requests prevented).
 */
export const idempotencyHits = new promClient.Counter({
  name: 'facetime_idempotency_hits_total',
  help: 'Number of duplicate call initiations prevented by idempotency',
});

/**
 * Idempotency key cache misses (new requests).
 */
export const idempotencyMisses = new promClient.Counter({
  name: 'facetime_idempotency_misses_total',
  help: 'Number of new call initiations (idempotency key not found)',
});

// ============================================================================
// Circuit Breaker Metrics
// ============================================================================

/**
 * Circuit breaker state changes.
 */
export const circuitBreakerState = new promClient.Gauge({
  name: 'facetime_circuit_breaker_state',
  help: 'Circuit breaker state (0=closed, 1=open, 2=half-open)',
  labelNames: ['name'] as const,
});

/**
 * Circuit breaker trip count.
 */
export const circuitBreakerTrips = new promClient.Counter({
  name: 'facetime_circuit_breaker_trips_total',
  help: 'Number of times circuit breaker has tripped',
  labelNames: ['name'] as const,
});

// ============================================================================
// Cache Metrics
// ============================================================================

/**
 * Cache hit rate.
 */
export const cacheHits = new promClient.Counter({
  name: 'facetime_cache_hits_total',
  help: 'Cache hits by type',
  labelNames: ['cache_type'] as const,
});

/**
 * Cache miss rate.
 */
export const cacheMisses = new promClient.Counter({
  name: 'facetime_cache_misses_total',
  help: 'Cache misses by type',
  labelNames: ['cache_type'] as const,
});

// ============================================================================
// Export Prometheus Registry
// ============================================================================

export const register = promClient.register;

/**
 * Returns the current metrics in Prometheus exposition format.
 */
export async function getMetrics(): Promise<string> {
  return register.metrics();
}

/**
 * Returns the content type for Prometheus metrics.
 */
export function getContentType(): string {
  return register.contentType;
}
