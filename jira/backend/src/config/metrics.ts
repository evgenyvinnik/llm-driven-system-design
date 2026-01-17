import { Registry, Counter, Histogram, collectDefaultMetrics } from 'prom-client';
import { logger } from './logger.js';

/**
 * Prometheus metrics registry.
 * Single registry for all application metrics, enabling /metrics endpoint exposure.
 */
export const metricsRegistry = new Registry();

// Collect default Node.js metrics (memory, CPU, event loop lag, etc.)
collectDefaultMetrics({ register: metricsRegistry });

/**
 * Counter for total issues created.
 * Labels: project_key, issue_type
 */
export const issuesCreatedCounter = new Counter({
  name: 'jira_issues_created_total',
  help: 'Total number of issues created',
  labelNames: ['project_key', 'issue_type'],
  registers: [metricsRegistry],
});

/**
 * Counter for total workflow transitions executed.
 * Labels: project_key, from_status, to_status
 */
export const transitionsCounter = new Counter({
  name: 'jira_transitions_total',
  help: 'Total number of workflow transitions executed',
  labelNames: ['project_key', 'from_status', 'to_status'],
  registers: [metricsRegistry],
});

/**
 * Counter for search queries executed.
 * Labels: query_type (jql, text, quick)
 */
export const searchQueriesCounter = new Counter({
  name: 'jira_search_queries_total',
  help: 'Total number of search queries executed',
  labelNames: ['query_type'],
  registers: [metricsRegistry],
});

/**
 * Histogram for search query latency.
 * Labels: query_type
 */
export const searchLatencyHistogram = new Histogram({
  name: 'jira_search_latency_seconds',
  help: 'Search query latency in seconds',
  labelNames: ['query_type'],
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  registers: [metricsRegistry],
});

/**
 * Counter for cache hits.
 * Labels: cache_type (project, board, workflow)
 */
export const cacheHitsCounter = new Counter({
  name: 'jira_cache_hits_total',
  help: 'Total number of cache hits',
  labelNames: ['cache_type'],
  registers: [metricsRegistry],
});

/**
 * Counter for cache misses.
 * Labels: cache_type (project, board, workflow)
 */
export const cacheMissesCounter = new Counter({
  name: 'jira_cache_misses_total',
  help: 'Total number of cache misses',
  labelNames: ['cache_type'],
  registers: [metricsRegistry],
});

/**
 * Counter for idempotent request replays.
 * Tracks when a cached response is returned for a duplicate request.
 */
export const idempotentReplaysCounter = new Counter({
  name: 'jira_idempotent_replays_total',
  help: 'Total number of idempotent request replays',
  registers: [metricsRegistry],
});

/**
 * Counter for messages published to RabbitMQ.
 * Labels: queue_name
 */
export const messagesPublishedCounter = new Counter({
  name: 'jira_messages_published_total',
  help: 'Total number of messages published to RabbitMQ',
  labelNames: ['queue_name'],
  registers: [metricsRegistry],
});

/**
 * Counter for messages consumed from RabbitMQ.
 * Labels: queue_name, status (success, error)
 */
export const messagesConsumedCounter = new Counter({
  name: 'jira_messages_consumed_total',
  help: 'Total number of messages consumed from RabbitMQ',
  labelNames: ['queue_name', 'status'],
  registers: [metricsRegistry],
});

/**
 * Counter for HTTP requests.
 * Labels: method, path, status_code
 */
export const httpRequestsCounter = new Counter({
  name: 'jira_http_requests_total',
  help: 'Total number of HTTP requests',
  labelNames: ['method', 'path', 'status_code'],
  registers: [metricsRegistry],
});

/**
 * Histogram for HTTP request latency.
 * Labels: method, path
 */
export const httpLatencyHistogram = new Histogram({
  name: 'jira_http_latency_seconds',
  help: 'HTTP request latency in seconds',
  labelNames: ['method', 'path'],
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [metricsRegistry],
});

logger.info('Prometheus metrics initialized');

export default metricsRegistry;
