import client from 'prom-client';

/**
 * Prometheus metrics for Reddit clone.
 *
 * Why metrics enable hot post detection and spam prevention:
 * - Vote velocity metrics identify suddenly popular content for "rising" feeds
 * - Unusual vote patterns (high rate from few accounts) indicate potential brigading
 * - Request latency histograms surface performance degradation before users complain
 * - Comment depth distribution helps identify deep thread engagement vs spam
 */

// Create a new registry to avoid conflicts with other metrics
export const register = new client.Registry();

// Add default Node.js metrics (memory, CPU, event loop lag)
client.collectDefaultMetrics({
  register,
  prefix: 'reddit_',
});

// ============================================================================
// HTTP Request Metrics
// ============================================================================

export const httpRequestDuration = new client.Histogram({
  name: 'reddit_http_request_duration_seconds',
  help: 'HTTP request duration in seconds',
  labelNames: ['method', 'route', 'status_code'],
  buckets: [0.01, 0.05, 0.1, 0.2, 0.5, 1, 2, 5],
  registers: [register],
});

export const httpRequestTotal = new client.Counter({
  name: 'reddit_http_requests_total',
  help: 'Total number of HTTP requests',
  labelNames: ['method', 'route', 'status_code'],
  registers: [register],
});

// ============================================================================
// Vote Metrics - Critical for detecting brigading and trending content
// ============================================================================

export const voteTotal = new client.Counter({
  name: 'reddit_votes_total',
  help: 'Total votes cast',
  labelNames: ['direction', 'target_type'],
  registers: [register],
});

export const voteAggregationLag = new client.Gauge({
  name: 'reddit_vote_aggregation_lag_seconds',
  help: 'Time since last vote aggregation completed',
  registers: [register],
});

export const voteAggregationDuration = new client.Histogram({
  name: 'reddit_vote_aggregation_duration_seconds',
  help: 'Duration of vote aggregation batch',
  buckets: [0.1, 0.5, 1, 2, 5, 10, 30],
  registers: [register],
});

// ============================================================================
// Post and Comment Metrics
// ============================================================================

export const postCreatedTotal = new client.Counter({
  name: 'reddit_posts_created_total',
  help: 'Total posts created',
  labelNames: ['subreddit'],
  registers: [register],
});

export const commentCreatedTotal = new client.Counter({
  name: 'reddit_comments_created_total',
  help: 'Total comments created',
  labelNames: ['depth_bucket'],
  registers: [register],
});

export const commentTreeDepth = new client.Histogram({
  name: 'reddit_comment_tree_depth',
  help: 'Comment tree depth distribution',
  buckets: [1, 2, 3, 5, 10, 15, 20],
  registers: [register],
});

// ============================================================================
// Karma Metrics
// ============================================================================

export const karmaCalculationDuration = new client.Histogram({
  name: 'reddit_karma_calculation_duration_seconds',
  help: 'Duration of karma recalculation',
  buckets: [0.01, 0.05, 0.1, 0.5, 1, 5],
  registers: [register],
});

// ============================================================================
// Hot Score Ranking Metrics
// ============================================================================

export const hotScoreCalculationDuration = new client.Histogram({
  name: 'reddit_hot_score_calculation_duration_seconds',
  help: 'Duration of hot score batch calculation',
  buckets: [0.5, 1, 2, 5, 10, 30, 60],
  registers: [register],
});

export const hotScorePostsProcessed = new client.Gauge({
  name: 'reddit_hot_score_posts_processed',
  help: 'Number of posts processed in last hot score calculation',
  registers: [register],
});

// ============================================================================
// Database Connection Pool Metrics
// ============================================================================

export const dbPoolSize = new client.Gauge({
  name: 'reddit_db_pool_size',
  help: 'Current database connection pool size',
  labelNames: ['state'],
  registers: [register],
});

export const dbQueryDuration = new client.Histogram({
  name: 'reddit_db_query_duration_seconds',
  help: 'Database query duration in seconds',
  labelNames: ['operation'],
  buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1],
  registers: [register],
});

// ============================================================================
// Cache Metrics
// ============================================================================

export const cacheHits = new client.Counter({
  name: 'reddit_cache_hits_total',
  help: 'Total cache hits',
  labelNames: ['cache_type'],
  registers: [register],
});

export const cacheMisses = new client.Counter({
  name: 'reddit_cache_misses_total',
  help: 'Total cache misses',
  labelNames: ['cache_type'],
  registers: [register],
});

// ============================================================================
// Audit Log Metrics
// ============================================================================

export const auditEventsTotal = new client.Counter({
  name: 'reddit_audit_events_total',
  help: 'Total audit events logged',
  labelNames: ['action', 'target_type'],
  registers: [register],
});

// ============================================================================
// Express Middleware for Request Metrics
// ============================================================================

/**
 * Middleware to collect HTTP metrics for each request.
 * Normalizes route patterns to avoid high cardinality label explosion.
 */
export const metricsMiddleware = (req, res, next) => {
  const start = process.hrtime.bigint();

  res.on('finish', () => {
    const end = process.hrtime.bigint();
    const durationSeconds = Number(end - start) / 1e9;

    // Normalize route to avoid high cardinality
    const route = normalizeRoute(req.route?.path || req.path);
    const method = req.method;
    const statusCode = res.statusCode;

    httpRequestDuration.observe(
      { method, route, status_code: statusCode },
      durationSeconds
    );

    httpRequestTotal.inc({ method, route, status_code: statusCode });
  });

  next();
};

/**
 * Normalize routes to prevent cardinality explosion.
 * Replace dynamic segments with placeholders.
 */
function normalizeRoute(path) {
  return path
    .replace(/\/\d+/g, '/:id')
    .replace(/\/[a-f0-9-]{36}/g, '/:uuid')
    .replace(/\/r\/[^/]+/g, '/r/:subreddit');
}

export default register;
