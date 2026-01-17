/**
 * @fileoverview Prometheus metrics for monitoring and observability.
 * Exposes counters, histograms, and gauges for key system operations.
 * Metrics are collected at /metrics endpoint in Prometheus format.
 */

import { Registry, Counter, Histogram, Gauge, collectDefaultMetrics } from 'prom-client';

/** Prometheus registry for all custom metrics */
export const register = new Registry();

// Collect default Node.js metrics (memory, CPU, event loop, etc.)
collectDefaultMetrics({ register });

// --- HTTP Request Metrics ---

/**
 * Total count of HTTP requests received.
 * Labels: method, path, status
 */
export const httpRequestsTotal = new Counter({
  name: 'http_requests_total',
  help: 'Total number of HTTP requests',
  labelNames: ['method', 'path', 'status'],
  registers: [register],
});

/**
 * Histogram of HTTP request durations.
 * Labels: method, path
 * Buckets: 10ms, 25ms, 50ms, 100ms, 200ms, 500ms, 1s, 2s, 5s
 */
export const httpRequestDuration = new Histogram({
  name: 'http_request_duration_seconds',
  help: 'Duration of HTTP requests in seconds',
  labelNames: ['method', 'path'],
  buckets: [0.01, 0.025, 0.05, 0.1, 0.2, 0.5, 1, 2, 5],
  registers: [register],
});

// --- Post Metrics ---

/**
 * Total count of posts created.
 * Labels: post_type, privacy
 */
export const postsCreatedTotal = new Counter({
  name: 'posts_created_total',
  help: 'Total number of posts created',
  labelNames: ['post_type', 'privacy'],
  registers: [register],
});

/**
 * Total count of post likes.
 * Labels: action (like, unlike)
 */
export const postLikesTotal = new Counter({
  name: 'post_likes_total',
  help: 'Total number of post likes',
  labelNames: ['action'],
  registers: [register],
});

/**
 * Total count of comments created.
 */
export const commentsCreatedTotal = new Counter({
  name: 'comments_created_total',
  help: 'Total number of comments created',
  registers: [register],
});

// --- Feed Metrics ---

/**
 * Histogram of feed generation duration.
 * Labels: cache_hit (true/false)
 */
export const feedGenerationDuration = new Histogram({
  name: 'feed_generation_duration_seconds',
  help: 'Duration of feed generation in seconds',
  labelNames: ['cache_hit'],
  buckets: [0.01, 0.025, 0.05, 0.1, 0.2, 0.5, 1, 2],
  registers: [register],
});

/**
 * Total count of feed requests.
 * Labels: type (home, explore)
 */
export const feedRequestsTotal = new Counter({
  name: 'feed_requests_total',
  help: 'Total number of feed requests',
  labelNames: ['type'],
  registers: [register],
});

/**
 * Histogram of posts returned per feed request.
 */
export const feedPostsCount = new Histogram({
  name: 'feed_posts_count',
  help: 'Number of posts returned per feed request',
  buckets: [0, 5, 10, 15, 20, 25, 30, 40, 50],
  registers: [register],
});

// --- Fanout Metrics ---

/**
 * Total count of fanout operations.
 * Labels: author_type (regular, celebrity)
 */
export const fanoutOperationsTotal = new Counter({
  name: 'fanout_operations_total',
  help: 'Total number of fanout operations',
  labelNames: ['author_type'],
  registers: [register],
});

/**
 * Histogram of followers notified per fanout operation.
 */
export const fanoutFollowersCount = new Histogram({
  name: 'fanout_followers_count',
  help: 'Number of followers notified per fanout operation',
  buckets: [0, 10, 50, 100, 500, 1000, 5000, 10000],
  registers: [register],
});

/**
 * Histogram of fanout operation duration.
 */
export const fanoutDuration = new Histogram({
  name: 'fanout_duration_seconds',
  help: 'Duration of fanout operations in seconds',
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 5],
  registers: [register],
});

// --- Cache Metrics ---

/**
 * Total count of cache operations.
 * Labels: cache_name (feed, session, celebrity_posts), result (hit, miss)
 */
export const cacheOperationsTotal = new Counter({
  name: 'cache_operations_total',
  help: 'Total number of cache operations',
  labelNames: ['cache_name', 'result'],
  registers: [register],
});

// --- Database Metrics ---

/**
 * Histogram of database query duration.
 * Labels: query_name (for identifying slow queries)
 */
export const dbQueryDuration = new Histogram({
  name: 'db_query_duration_seconds',
  help: 'Duration of database queries in seconds',
  labelNames: ['query_name'],
  buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1],
  registers: [register],
});

// --- WebSocket Metrics ---

/**
 * Current number of active WebSocket connections.
 */
export const wsActiveConnections = new Gauge({
  name: 'websocket_active_connections',
  help: 'Number of active WebSocket connections',
  registers: [register],
});

/**
 * Total count of WebSocket messages sent.
 * Labels: type (new_post, connected, error)
 */
export const wsMessagesTotal = new Counter({
  name: 'websocket_messages_total',
  help: 'Total number of WebSocket messages sent',
  labelNames: ['type'],
  registers: [register],
});

// --- Authentication Metrics ---

/**
 * Total count of authentication attempts.
 * Labels: action (login, register, logout), result (success, failure)
 */
export const authAttemptsTotal = new Counter({
  name: 'auth_attempts_total',
  help: 'Total number of authentication attempts',
  labelNames: ['action', 'result'],
  registers: [register],
});

// --- Circuit Breaker Metrics ---

/**
 * Current state of circuit breakers.
 * Labels: name (feed, fanout)
 * Values: 0 = closed, 1 = half-open, 2 = open
 */
export const circuitBreakerState = new Gauge({
  name: 'circuit_breaker_state',
  help: 'Current state of circuit breakers (0=closed, 1=half-open, 2=open)',
  labelNames: ['name'],
  registers: [register],
});

/**
 * Total count of circuit breaker state changes.
 * Labels: name, from_state, to_state
 */
export const circuitBreakerStateChanges = new Counter({
  name: 'circuit_breaker_state_changes_total',
  help: 'Total number of circuit breaker state changes',
  labelNames: ['name', 'from_state', 'to_state'],
  registers: [register],
});

// --- Health Metrics ---

/**
 * Health status of each component.
 * Labels: component (database, redis, websocket)
 * Values: 0 = unhealthy, 1 = healthy
 */
export const componentHealth = new Gauge({
  name: 'component_health',
  help: 'Health status of components (0=unhealthy, 1=healthy)',
  labelNames: ['component'],
  registers: [register],
});

/**
 * Latency of health check probes.
 * Labels: component
 */
export const healthCheckLatency = new Histogram({
  name: 'health_check_latency_seconds',
  help: 'Latency of health check probes in seconds',
  labelNames: ['component'],
  buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1],
  registers: [register],
});
