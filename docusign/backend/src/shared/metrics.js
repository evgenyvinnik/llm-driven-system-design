import client from 'prom-client';

// Create a Registry to register metrics
const register = new client.Registry();

// Add default metrics (CPU, memory, event loop, etc.)
client.collectDefaultMetrics({ register });

// Document status metrics
export const documentsTotal = new client.Counter({
  name: 'docusign_documents_total',
  help: 'Total number of documents uploaded',
  registers: [register],
});

export const envelopesCreated = new client.Counter({
  name: 'docusign_envelopes_created_total',
  help: 'Total number of envelopes created',
  registers: [register],
});

export const envelopesByStatus = new client.Gauge({
  name: 'docusign_envelopes_by_status',
  help: 'Current number of envelopes by status',
  labelNames: ['status'],
  registers: [register],
});

export const signaturesCaptured = new client.Counter({
  name: 'docusign_signatures_captured_total',
  help: 'Total number of signatures captured',
  registers: [register],
});

export const signaturesCompleted = new client.Counter({
  name: 'docusign_signatures_completed_total',
  help: 'Total number of completed signing sessions',
  registers: [register],
});

export const signaturesPending = new client.Gauge({
  name: 'docusign_signatures_pending',
  help: 'Current number of pending signatures',
  registers: [register],
});

export const signaturesExpired = new client.Counter({
  name: 'docusign_signatures_expired_total',
  help: 'Total number of expired signature requests',
  registers: [register],
});

// Request duration histogram
export const httpRequestDuration = new client.Histogram({
  name: 'docusign_http_request_duration_seconds',
  help: 'Duration of HTTP requests in seconds',
  labelNames: ['method', 'route', 'status_code'],
  buckets: [0.01, 0.05, 0.1, 0.5, 1, 2, 5],
  registers: [register],
});

// Queue metrics
export const queueMessagesPublished = new client.Counter({
  name: 'docusign_queue_messages_published_total',
  help: 'Total messages published to queue',
  labelNames: ['queue'],
  registers: [register],
});

export const queueMessagesProcessed = new client.Counter({
  name: 'docusign_queue_messages_processed_total',
  help: 'Total messages processed from queue',
  labelNames: ['queue', 'status'],
  registers: [register],
});

export const queueMessagesRetried = new client.Counter({
  name: 'docusign_queue_messages_retried_total',
  help: 'Total messages retried',
  labelNames: ['queue'],
  registers: [register],
});

// Circuit breaker metrics
export const circuitBreakerState = new client.Gauge({
  name: 'docusign_circuit_breaker_state',
  help: 'Circuit breaker state (0=closed, 1=open, 2=half-open)',
  labelNames: ['name'],
  registers: [register],
});

export const circuitBreakerFailures = new client.Counter({
  name: 'docusign_circuit_breaker_failures_total',
  help: 'Total circuit breaker failures',
  labelNames: ['name'],
  registers: [register],
});

// Storage operation metrics
export const storageOperationDuration = new client.Histogram({
  name: 'docusign_storage_operation_duration_seconds',
  help: 'Duration of storage operations',
  labelNames: ['operation', 'bucket'],
  buckets: [0.01, 0.05, 0.1, 0.5, 1, 2, 5, 10],
  registers: [register],
});

export const storageOperationErrors = new client.Counter({
  name: 'docusign_storage_operation_errors_total',
  help: 'Total storage operation errors',
  labelNames: ['operation', 'bucket'],
  registers: [register],
});

// Idempotency metrics
export const idempotencyHits = new client.Counter({
  name: 'docusign_idempotency_hits_total',
  help: 'Total idempotency cache hits (duplicate requests)',
  labelNames: ['operation'],
  registers: [register],
});

export const idempotencyMisses = new client.Counter({
  name: 'docusign_idempotency_misses_total',
  help: 'Total idempotency cache misses (new requests)',
  labelNames: ['operation'],
  registers: [register],
});

// Audit trail metrics
export const auditEventsLogged = new client.Counter({
  name: 'docusign_audit_events_total',
  help: 'Total audit events logged',
  labelNames: ['event_type'],
  registers: [register],
});

// Express middleware for request metrics
export function metricsMiddleware(req, res, next) {
  const end = httpRequestDuration.startTimer();

  res.on('finish', () => {
    const route = req.route?.path || req.path || 'unknown';
    end({ method: req.method, route, status_code: res.statusCode });
  });

  next();
}

// Get metrics endpoint handler
export async function getMetrics(req, res) {
  res.set('Content-Type', register.contentType);
  res.end(await register.metrics());
}

export { register };
