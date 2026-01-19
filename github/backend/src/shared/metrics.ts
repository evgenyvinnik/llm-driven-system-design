import client from 'prom-client';

/**
 * Prometheus metrics for GitHub clone
 *
 * Metrics categories:
 * - HTTP request latency and counts
 * - Git operations (push, clone, merge)
 * - Cache hit/miss rates
 * - Issue/PR/CI run counts
 * - Webhook delivery status
 */

// Enable default metrics (CPU, memory, event loop, etc.)
client.collectDefaultMetrics({
  prefix: 'github_',
});

// HTTP Request Metrics
export const httpRequestDuration = new client.Histogram({
  name: 'github_http_request_duration_seconds',
  help: 'HTTP request latency in seconds',
  labelNames: ['method', 'route', 'status_code'],
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
});

export const httpRequestsTotal = new client.Counter({
  name: 'github_http_requests_total',
  help: 'Total number of HTTP requests',
  labelNames: ['method', 'route', 'status_code'],
});

// Git Operation Metrics
export const gitOperationDuration = new client.Histogram({
  name: 'github_git_operation_duration_seconds',
  help: 'Git operation latency in seconds',
  labelNames: ['operation'], // push, clone, fetch, merge, diff
  buckets: [0.1, 0.5, 1, 5, 10, 30, 60],
});

export const gitOperationsTotal = new client.Counter({
  name: 'github_git_operations_total',
  help: 'Total number of git operations',
  labelNames: ['operation', 'status'], // status: success, failure
});

export const pushesTotal = new client.Counter({
  name: 'github_pushes_total',
  help: 'Total number of pushes',
  labelNames: ['status'],
});

// Cache Metrics
export const cacheHits = new client.Counter({
  name: 'github_cache_hits_total',
  help: 'Total cache hits',
  labelNames: ['cache_type'], // repo_metadata, file_tree, file_content, pr_diff
});

export const cacheMisses = new client.Counter({
  name: 'github_cache_misses_total',
  help: 'Total cache misses',
  labelNames: ['cache_type'],
});

export const cacheOperations = new client.Histogram({
  name: 'github_cache_operation_duration_seconds',
  help: 'Cache operation latency in seconds',
  labelNames: ['operation'], // get, set, delete
  buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1],
});

// Pull Request Metrics
export const prsCreated = new client.Counter({
  name: 'github_prs_created_total',
  help: 'Total pull requests created',
  labelNames: ['status'], // success, duplicate
});

export const prsMerged = new client.Counter({
  name: 'github_prs_merged_total',
  help: 'Total pull requests merged',
  labelNames: ['strategy'], // merge, squash, rebase
});

// Issue Metrics
export const issuesCreated = new client.Counter({
  name: 'github_issues_created_total',
  help: 'Total issues created',
  labelNames: ['status'], // success, duplicate
});

export const issuesClosed = new client.Counter({
  name: 'github_issues_closed_total',
  help: 'Total issues closed',
});

// CI Run Metrics (for future use)
export const ciRunsTotal = new client.Counter({
  name: 'github_ci_runs_total',
  help: 'Total CI runs',
  labelNames: ['status', 'trigger'], // status: success, failure, cancelled; trigger: push, pr, manual
});

export const ciRunDuration = new client.Histogram({
  name: 'github_ci_run_duration_seconds',
  help: 'CI run duration in seconds',
  labelNames: ['status'],
  buckets: [10, 30, 60, 120, 300, 600, 1200, 1800, 3600],
});

// Webhook Metrics
export const webhookDeliveries = new client.Counter({
  name: 'github_webhook_deliveries_total',
  help: 'Total webhook delivery attempts',
  labelNames: ['status', 'event_type'], // status: success, failed, retrying
});

export const webhookDeliveryDuration = new client.Histogram({
  name: 'github_webhook_delivery_duration_seconds',
  help: 'Webhook delivery latency in seconds',
  labelNames: ['status'],
  buckets: [0.1, 0.5, 1, 2.5, 5, 10, 30],
});

// Active Connections Gauge
export const activeConnections = new client.Gauge({
  name: 'github_active_connections',
  help: 'Number of active connections',
  labelNames: ['type'], // http, websocket, git_ssh
});

// Circuit Breaker Metrics
export const circuitBreakerState = new client.Gauge({
  name: 'github_circuit_breaker_state',
  help: 'Circuit breaker state (0=closed, 1=open, 2=half-open)',
  labelNames: ['service'],
});

export const circuitBreakerTrips = new client.Counter({
  name: 'github_circuit_breaker_trips_total',
  help: 'Number of times circuit breaker has tripped',
  labelNames: ['service'],
});

// Idempotency Metrics
export const idempotencyDuplicates = new client.Counter({
  name: 'github_idempotency_duplicates_total',
  help: 'Number of duplicate requests caught by idempotency',
  labelNames: ['operation'], // pr_create, issue_create
});

import { Request, Response, NextFunction } from 'express';

/**
 * Express middleware to record request metrics
 */
export function metricsMiddleware(req: Request, res: Response, next: NextFunction): void {
  const startTime = Date.now();

  // Track active connections
  activeConnections.inc({ type: 'http' });

  res.on('finish', () => {
    const duration = (Date.now() - startTime) / 1000;
    const route = req.route?.path || req.path;
    const statusCode = res.statusCode.toString();

    httpRequestDuration.observe({ method: req.method, route, status_code: statusCode }, duration);
    httpRequestsTotal.inc({ method: req.method, route, status_code: statusCode });
    activeConnections.dec({ type: 'http' });
  });

  next();
}

/**
 * Get metrics endpoint handler
 */
export async function metricsHandler(_req: Request, res: Response): Promise<void> {
  try {
    res.set('Content-Type', client.register.contentType);
    res.end(await client.register.metrics());
  } catch (err) {
    res.status(500).end((err as Error).message);
  }
}

export default client;
