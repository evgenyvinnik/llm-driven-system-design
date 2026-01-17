/**
 * Prometheus metrics configuration for observability.
 * Tracks HTTP requests, business metrics, and system health.
 *
 * @module utils/metrics
 */
import client, { Registry, Counter, Histogram, Gauge } from 'prom-client';
import { Request, Response, NextFunction } from 'express';
import { getQueueDepth, QUEUES } from './rabbitmq.js';

// Create a custom registry
export const metricsRegistry = new Registry();

// Add default metrics (CPU, memory, event loop)
client.collectDefaultMetrics({ register: metricsRegistry });

// HTTP Request Metrics
export const httpRequestsTotal = new Counter({
  name: 'http_requests_total',
  help: 'Total number of HTTP requests',
  labelNames: ['method', 'path', 'status'],
  registers: [metricsRegistry],
});

export const httpRequestDuration = new Histogram({
  name: 'http_request_duration_seconds',
  help: 'Duration of HTTP requests in seconds',
  labelNames: ['method', 'path'],
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [metricsRegistry],
});

// Business Metrics
export const connectionsCreatedTotal = new Counter({
  name: 'connections_created_total',
  help: 'Total number of connections created',
  registers: [metricsRegistry],
});

export const connectionsRemovedTotal = new Counter({
  name: 'connections_removed_total',
  help: 'Total number of connections removed',
  registers: [metricsRegistry],
});

export const connectionRequestsTotal = new Counter({
  name: 'connection_requests_total',
  help: 'Total number of connection requests sent',
  registers: [metricsRegistry],
});

export const postsCreatedTotal = new Counter({
  name: 'posts_created_total',
  help: 'Total number of posts created',
  registers: [metricsRegistry],
});

export const postLikesTotal = new Counter({
  name: 'post_likes_total',
  help: 'Total number of post likes',
  registers: [metricsRegistry],
});

export const postCommentsTotal = new Counter({
  name: 'post_comments_total',
  help: 'Total number of post comments',
  registers: [metricsRegistry],
});

export const profileViewsTotal = new Counter({
  name: 'profile_views_total',
  help: 'Total number of profile views',
  registers: [metricsRegistry],
});

export const profileUpdatesTotal = new Counter({
  name: 'profile_updates_total',
  help: 'Total number of profile updates',
  registers: [metricsRegistry],
});

export const searchQueriesTotal = new Counter({
  name: 'search_queries_total',
  help: 'Total number of search queries',
  labelNames: ['type'], // 'user', 'job'
  registers: [metricsRegistry],
});

// Session Metrics
export const activeSessions = new Gauge({
  name: 'active_sessions',
  help: 'Current number of active sessions',
  registers: [metricsRegistry],
});

// Rate Limiting Metrics
export const rateLimitHitsTotal = new Counter({
  name: 'rate_limit_hits_total',
  help: 'Total number of rate limit hits',
  labelNames: ['category'],
  registers: [metricsRegistry],
});

// Queue Metrics
export const queueDepth = new Gauge({
  name: 'queue_depth',
  help: 'Current number of messages in queue',
  labelNames: ['queue_name'],
  registers: [metricsRegistry],
});

export const queueProcessingDuration = new Histogram({
  name: 'queue_processing_duration_seconds',
  help: 'Duration of queue message processing',
  labelNames: ['queue_name'],
  buckets: [0.1, 0.5, 1, 5, 10, 30, 60],
  registers: [metricsRegistry],
});

// Database Metrics
export const dbQueryDuration = new Histogram({
  name: 'db_query_duration_seconds',
  help: 'Duration of database queries',
  labelNames: ['query_type'], // 'select', 'insert', 'update', 'delete'
  buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1],
  registers: [metricsRegistry],
});

// Cache Metrics
export const cacheHitsTotal = new Counter({
  name: 'cache_hits_total',
  help: 'Total number of cache hits',
  labelNames: ['cache_name'],
  registers: [metricsRegistry],
});

export const cacheMissesTotal = new Counter({
  name: 'cache_misses_total',
  help: 'Total number of cache misses',
  labelNames: ['cache_name'],
  registers: [metricsRegistry],
});

// PYMK Metrics
export const pymkComputationDuration = new Histogram({
  name: 'pymk_computation_duration_seconds',
  help: 'Duration of PYMK computation',
  labelNames: ['user_network_size'],
  buckets: [0.1, 0.5, 1, 5, 10, 30, 60],
  registers: [metricsRegistry],
});

// Feed Metrics
export const feedGenerationDuration = new Histogram({
  name: 'feed_generation_duration_seconds',
  help: 'Duration of feed generation',
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1],
  registers: [metricsRegistry],
});

// Authentication Metrics
export const loginAttemptsTotal = new Counter({
  name: 'login_attempts_total',
  help: 'Total number of login attempts',
  labelNames: ['success'],
  registers: [metricsRegistry],
});

/**
 * Express middleware for tracking HTTP request metrics.
 * Records request count and duration with method/path/status labels.
 */
export function metricsMiddleware(req: Request, res: Response, next: NextFunction): void {
  const start = Date.now();

  res.on('finish', () => {
    const duration = (Date.now() - start) / 1000;
    const path = normalizePath(req.route?.path || req.path);

    httpRequestsTotal.inc({
      method: req.method,
      path,
      status: res.statusCode.toString(),
    });

    httpRequestDuration.observe(
      { method: req.method, path },
      duration
    );
  });

  next();
}

/**
 * Normalizes paths for consistent metric labels.
 * Replaces dynamic segments like /users/123 with /users/:id
 */
function normalizePath(path: string): string {
  return path
    .replace(/\/\d+/g, '/:id')
    .replace(/\/[a-f0-9-]{36}/g, '/:uuid');
}

/**
 * Updates queue depth metrics for all queues.
 * Should be called periodically by a background task.
 */
export async function updateQueueMetrics(): Promise<void> {
  for (const [name, queue] of Object.entries(QUEUES)) {
    const depth = await getQueueDepth(queue);
    queueDepth.set({ queue_name: queue }, depth);
  }
}

/**
 * Gets all metrics in Prometheus text format.
 */
export async function getMetrics(): Promise<string> {
  return metricsRegistry.metrics();
}

/**
 * Gets the content type for metrics response.
 */
export function getMetricsContentType(): string {
  return metricsRegistry.contentType;
}

export default metricsRegistry;
