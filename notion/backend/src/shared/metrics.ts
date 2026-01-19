/**
 * @fileoverview Prometheus metrics for application observability.
 * Tracks request latency, page loads, edits, search queries, cache performance,
 * queue depth, and WebSocket connections for performance monitoring.
 */

import { Counter, Histogram, Gauge, Registry, collectDefaultMetrics } from 'prom-client';
import type { Request, Response, NextFunction } from 'express';

/**
 * Custom Prometheus registry for the application.
 */
export const registry = new Registry();

// Collect default Node.js metrics (memory, CPU, event loop, etc.)
collectDefaultMetrics({ register: registry });

// ============================================================================
// HTTP Request Metrics
// ============================================================================

/**
 * HTTP request duration histogram by method, route, and status code.
 */
export const httpRequestDuration = new Histogram({
  name: 'http_request_duration_seconds',
  help: 'Duration of HTTP requests in seconds',
  labelNames: ['method', 'route', 'status_code'],
  buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [registry],
});

/**
 * HTTP requests total counter by method, route, and status code.
 */
export const httpRequestsTotal = new Counter({
  name: 'http_requests_total',
  help: 'Total number of HTTP requests',
  labelNames: ['method', 'route', 'status_code'],
  registers: [registry],
});

// ============================================================================
// Page and Block Metrics
// ============================================================================

/**
 * Page load operations counter.
 */
export const pageLoadsCounter = new Counter({
  name: 'page_loads_total',
  help: 'Total number of page load operations',
  labelNames: ['workspace_id'],
  registers: [registry],
});

/**
 * Page edit operations counter.
 */
export const pageEditsCounter = new Counter({
  name: 'page_edits_total',
  help: 'Total number of page edit operations',
  labelNames: ['operation_type'], // create, update, delete
  registers: [registry],
});

/**
 * Block operations counter.
 */
export const blockOperationsCounter = new Counter({
  name: 'block_operations_total',
  help: 'Total number of block operations',
  labelNames: ['type', 'status'], // type: insert/update/delete/move, status: success/error
  registers: [registry],
});

/**
 * Page load duration histogram.
 */
export const pageLoadDuration = new Histogram({
  name: 'page_load_duration_seconds',
  help: 'Duration of page load operations in seconds',
  labelNames: ['has_cache'],
  buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2],
  registers: [registry],
});

// ============================================================================
// Search Metrics
// ============================================================================

/**
 * Search query counter.
 */
export const searchQueriesCounter = new Counter({
  name: 'search_queries_total',
  help: 'Total number of search queries',
  labelNames: ['workspace_id', 'has_results'],
  registers: [registry],
});

/**
 * Search query duration histogram.
 */
export const searchQueryDuration = new Histogram({
  name: 'search_query_duration_seconds',
  help: 'Duration of search queries in seconds',
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2],
  registers: [registry],
});

// ============================================================================
// Cache Metrics
// ============================================================================

/**
 * Cache hits counter by cache type.
 */
export const cacheHitsCounter = new Counter({
  name: 'cache_hits_total',
  help: 'Total cache hits',
  labelNames: ['cache_type'], // page, blocks, workspace, search
  registers: [registry],
});

/**
 * Cache misses counter by cache type.
 */
export const cacheMissesCounter = new Counter({
  name: 'cache_misses_total',
  help: 'Total cache misses',
  labelNames: ['cache_type'],
  registers: [registry],
});

/**
 * Cache operation duration histogram.
 */
export const cacheOperationDuration = new Histogram({
  name: 'cache_operation_duration_seconds',
  help: 'Duration of cache operations in seconds',
  labelNames: ['operation', 'cache_type'], // operation: get/set/delete
  buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1],
  registers: [registry],
});

// ============================================================================
// Queue Metrics
// ============================================================================

/**
 * Queue messages published counter.
 */
export const queueMessagesPublished = new Counter({
  name: 'queue_messages_published_total',
  help: 'Total messages published to queue',
  labelNames: ['queue_name'],
  registers: [registry],
});

/**
 * Queue messages processed counter.
 */
export const queueMessagesProcessed = new Counter({
  name: 'queue_messages_processed_total',
  help: 'Total messages processed from queue',
  labelNames: ['queue_name', 'status'], // status: success/failure
  registers: [registry],
});

/**
 * Queue depth gauge.
 */
export const queueDepthGauge = new Gauge({
  name: 'queue_depth',
  help: 'Current number of messages in queue',
  labelNames: ['queue_name'],
  registers: [registry],
});

/**
 * Queue processing duration histogram.
 */
export const queueProcessingDuration = new Histogram({
  name: 'queue_processing_duration_seconds',
  help: 'Duration of queue message processing in seconds',
  labelNames: ['queue_name'],
  buckets: [0.01, 0.05, 0.1, 0.5, 1, 5, 10, 30],
  registers: [registry],
});

// ============================================================================
// WebSocket Metrics
// ============================================================================

/**
 * Active WebSocket connections gauge.
 */
export const wsConnectionsGauge = new Gauge({
  name: 'websocket_connections_total',
  help: 'Current number of WebSocket connections',
  labelNames: ['server_id'],
  registers: [registry],
});

/**
 * WebSocket messages counter.
 */
export const wsMessagesCounter = new Counter({
  name: 'websocket_messages_total',
  help: 'Total WebSocket messages',
  labelNames: ['direction', 'type'], // direction: inbound/outbound, type: message type
  registers: [registry],
});

// ============================================================================
// Database Metrics
// ============================================================================

/**
 * Database query duration histogram.
 */
export const dbQueryDuration = new Histogram({
  name: 'db_query_duration_seconds',
  help: 'Duration of database queries in seconds',
  labelNames: ['query_type'], // select, insert, update, delete
  buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1],
  registers: [registry],
});

/**
 * Database connection pool gauge.
 */
export const dbPoolGauge = new Gauge({
  name: 'db_pool_connections',
  help: 'Number of connections in database pool',
  labelNames: ['state'], // idle, active, waiting
  registers: [registry],
});

// ============================================================================
// Express Middleware
// ============================================================================

/**
 * Normalizes route path for metrics labels.
 * Replaces dynamic segments like :id with :param.
 */
function normalizeRoute(path: string): string {
  return path
    .replace(/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '/:id')
    .replace(/\/\d+/g, '/:id')
    .replace(/\/[a-f0-9]{24}/gi, '/:id'); // MongoDB-style IDs
}

/**
 * Express middleware to track HTTP request metrics.
 */
export function metricsMiddleware(req: Request, res: Response, next: NextFunction): void {
  const startTime = process.hrtime.bigint();

  res.on('finish', () => {
    const durationNs = process.hrtime.bigint() - startTime;
    const durationSeconds = Number(durationNs) / 1e9;

    const route = normalizeRoute(req.path);
    const labels = {
      method: req.method,
      route,
      status_code: res.statusCode.toString(),
    };

    httpRequestDuration.observe(labels, durationSeconds);
    httpRequestsTotal.inc(labels);
  });

  next();
}

/**
 * Express handler for /metrics endpoint.
 * Returns Prometheus-formatted metrics.
 */
export async function metricsHandler(_req: Request, res: Response): Promise<void> {
  try {
    res.set('Content-Type', registry.contentType);
    res.end(await registry.metrics());
  } catch (_error) {
    res.status(500).end('Error collecting metrics');
  }
}

export default {
  registry,
  metricsMiddleware,
  metricsHandler,
  // Export individual metrics for use in other modules
  httpRequestDuration,
  httpRequestsTotal,
  pageLoadsCounter,
  pageEditsCounter,
  blockOperationsCounter,
  pageLoadDuration,
  searchQueriesCounter,
  searchQueryDuration,
  cacheHitsCounter,
  cacheMissesCounter,
  cacheOperationDuration,
  queueMessagesPublished,
  queueMessagesProcessed,
  queueDepthGauge,
  queueProcessingDuration,
  wsConnectionsGauge,
  wsMessagesCounter,
  dbQueryDuration,
  dbPoolGauge,
};
