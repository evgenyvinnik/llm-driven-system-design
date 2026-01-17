/**
 * Prometheus metrics for observability
 *
 * WHY: Metrics enable:
 * - Real-time monitoring of system health and performance
 * - Alerting on SLI violations (error rates, latency)
 * - Capacity planning through trend analysis
 * - Root cause analysis during incidents
 */

const client = require('prom-client');

// Create a Registry to register metrics
const register = new client.Registry();

// Add default Node.js metrics (memory, CPU, event loop lag)
client.collectDefaultMetrics({ register });

// ============================================================================
// BUSINESS METRICS - Core payment operations
// ============================================================================

/**
 * Counter for completed/failed transfers
 * Labels: status (completed, failed, insufficient_funds), funding_source (balance, bank, card)
 */
const transfersTotal = new client.Counter({
  name: 'venmo_transfers_total',
  help: 'Total number of transfers processed',
  labelNames: ['status', 'funding_source'],
  registers: [register],
});

/**
 * Histogram for transfer amounts (in cents)
 * Buckets optimized for common transfer amounts: $1, $5, $10, $50, $100, $500, $1000, $5000
 */
const transferAmountHistogram = new client.Histogram({
  name: 'venmo_transfer_amount_cents',
  help: 'Distribution of transfer amounts in cents',
  buckets: [100, 500, 1000, 5000, 10000, 50000, 100000, 500000],
  registers: [register],
});

/**
 * Counter for cashouts by speed and status
 */
const cashoutsTotal = new client.Counter({
  name: 'venmo_cashouts_total',
  help: 'Total number of cashouts processed',
  labelNames: ['speed', 'status'],
  registers: [register],
});

/**
 * Counter for payment requests
 */
const paymentRequestsTotal = new client.Counter({
  name: 'venmo_payment_requests_total',
  help: 'Total number of payment requests',
  labelNames: ['status'],
  registers: [register],
});

/**
 * Gauge for active user balance aggregate (for monitoring)
 */
const totalUserBalances = new client.Gauge({
  name: 'venmo_total_user_balances_cents',
  help: 'Sum of all user wallet balances in cents',
  registers: [register],
});

// ============================================================================
// SYSTEM METRICS - API and infrastructure performance
// ============================================================================

/**
 * Histogram for API request latency
 * Labels: endpoint, method, status_code
 */
const httpRequestDuration = new client.Histogram({
  name: 'venmo_http_request_duration_seconds',
  help: 'HTTP request latency in seconds',
  labelNames: ['method', 'route', 'status_code'],
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [register],
});

/**
 * Counter for HTTP requests
 */
const httpRequestsTotal = new client.Counter({
  name: 'venmo_http_requests_total',
  help: 'Total number of HTTP requests',
  labelNames: ['method', 'route', 'status_code'],
  registers: [register],
});

/**
 * Histogram for database query latency
 */
const dbQueryDuration = new client.Histogram({
  name: 'venmo_db_query_duration_seconds',
  help: 'Database query latency in seconds',
  labelNames: ['query_type', 'table'],
  buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1],
  registers: [register],
});

/**
 * Balance cache hit/miss tracking
 */
const balanceCacheHits = new client.Counter({
  name: 'venmo_balance_cache_hits_total',
  help: 'Balance cache hits',
  registers: [register],
});

const balanceCacheMisses = new client.Counter({
  name: 'venmo_balance_cache_misses_total',
  help: 'Balance cache misses',
  registers: [register],
});

/**
 * Histogram for feed fan-out duration
 */
const feedFanoutDuration = new client.Histogram({
  name: 'venmo_feed_fanout_duration_seconds',
  help: 'Time to fan out transfer to friend feeds',
  buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5],
  registers: [register],
});

// ============================================================================
// INFRASTRUCTURE METRICS - Connection pools and resources
// ============================================================================

/**
 * Gauge for PostgreSQL connection pool status
 */
const pgPoolActiveConnections = new client.Gauge({
  name: 'venmo_postgres_connections_active',
  help: 'Active PostgreSQL connections',
  registers: [register],
});

const pgPoolIdleConnections = new client.Gauge({
  name: 'venmo_postgres_connections_idle',
  help: 'Idle PostgreSQL connections',
  registers: [register],
});

const pgPoolWaitingCount = new client.Gauge({
  name: 'venmo_postgres_connections_waiting',
  help: 'Waiting PostgreSQL connection requests',
  registers: [register],
});

/**
 * Circuit breaker state tracking
 */
const circuitBreakerState = new client.Gauge({
  name: 'venmo_circuit_breaker_state',
  help: 'Circuit breaker state (0=closed, 1=half-open, 2=open)',
  labelNames: ['service'],
  registers: [register],
});

const circuitBreakerFailures = new client.Counter({
  name: 'venmo_circuit_breaker_failures_total',
  help: 'Circuit breaker failure count',
  labelNames: ['service'],
  registers: [register],
});

// ============================================================================
// AUDIT METRICS - Security and compliance
// ============================================================================

/**
 * Counter for audit events
 */
const auditEventsTotal = new client.Counter({
  name: 'venmo_audit_events_total',
  help: 'Total audit events recorded',
  labelNames: ['action', 'outcome'],
  registers: [register],
});

/**
 * Counter for idempotency cache hits (duplicate request prevention)
 */
const idempotencyCacheHits = new client.Counter({
  name: 'venmo_idempotency_cache_hits_total',
  help: 'Number of duplicate requests prevented by idempotency keys',
  registers: [register],
});

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Express middleware to track HTTP request metrics
 */
function metricsMiddleware(req, res, next) {
  const start = process.hrtime.bigint();

  // Hook into response finish to record metrics
  res.on('finish', () => {
    const durationNs = process.hrtime.bigint() - start;
    const durationSec = Number(durationNs) / 1e9;

    // Normalize route path (replace IDs with :id)
    const route = normalizeRoute(req.route?.path || req.path);

    const labels = {
      method: req.method,
      route,
      status_code: res.statusCode,
    };

    httpRequestDuration.observe(labels, durationSec);
    httpRequestsTotal.inc(labels);
  });

  next();
}

/**
 * Normalize route paths by replacing UUIDs and numeric IDs
 */
function normalizeRoute(path) {
  return path
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, ':id')
    .replace(/\/\d+/g, '/:id');
}

/**
 * Update PostgreSQL pool metrics
 */
function updatePoolMetrics(pool) {
  if (pool) {
    pgPoolActiveConnections.set(pool.totalCount - pool.idleCount);
    pgPoolIdleConnections.set(pool.idleCount);
    pgPoolWaitingCount.set(pool.waitingCount);
  }
}

module.exports = {
  register,
  // Business metrics
  transfersTotal,
  transferAmountHistogram,
  cashoutsTotal,
  paymentRequestsTotal,
  totalUserBalances,
  // System metrics
  httpRequestDuration,
  httpRequestsTotal,
  dbQueryDuration,
  balanceCacheHits,
  balanceCacheMisses,
  feedFanoutDuration,
  // Infrastructure metrics
  pgPoolActiveConnections,
  pgPoolIdleConnections,
  pgPoolWaitingCount,
  circuitBreakerState,
  circuitBreakerFailures,
  // Audit metrics
  auditEventsTotal,
  idempotencyCacheHits,
  // Helpers
  metricsMiddleware,
  updatePoolMetrics,
  normalizeRoute,
};
