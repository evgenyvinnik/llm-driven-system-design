/**
 * Prometheus Metrics
 *
 * Exposes application metrics for monitoring:
 * - HTTP request duration and counts
 * - Active streams and viewer counts
 * - Chat message rates
 * - WebSocket connections
 * - Subscription events
 */
const client = require('prom-client');

// Create a Registry to register metrics
const register = new client.Registry();

// Add default labels
register.setDefaultLabels({
  service: 'twitch-api',
  instance: process.env.INSTANCE_ID || `port-${process.env.PORT || 3001}`
});

// Collect default metrics (CPU, memory, event loop, etc.)
client.collectDefaultMetrics({ register });

// ===================
// HTTP Request Metrics
// ===================

const httpRequestDuration = new client.Histogram({
  name: 'http_request_duration_seconds',
  help: 'Duration of HTTP requests in seconds',
  labelNames: ['method', 'route', 'status_code'],
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10]
});
register.registerMetric(httpRequestDuration);

const httpRequestsTotal = new client.Counter({
  name: 'http_requests_total',
  help: 'Total number of HTTP requests',
  labelNames: ['method', 'route', 'status_code']
});
register.registerMetric(httpRequestsTotal);

// ===================
// Business Metrics
// ===================

// Stream metrics
const activeStreams = new client.Gauge({
  name: 'twitch_active_streams',
  help: 'Number of currently live streams'
});
register.registerMetric(activeStreams);

const totalViewers = new client.Gauge({
  name: 'twitch_total_viewers',
  help: 'Total viewers across all live streams'
});
register.registerMetric(totalViewers);

const streamStartsTotal = new client.Counter({
  name: 'twitch_stream_starts_total',
  help: 'Total number of streams started'
});
register.registerMetric(streamStartsTotal);

const streamEndsTotal = new client.Counter({
  name: 'twitch_stream_ends_total',
  help: 'Total number of streams ended'
});
register.registerMetric(streamEndsTotal);

// Chat metrics
const chatMessagesTotal = new client.Counter({
  name: 'twitch_chat_messages_total',
  help: 'Total chat messages processed',
  labelNames: ['channel_id']
});
register.registerMetric(chatMessagesTotal);

const chatMessagesDedupedTotal = new client.Counter({
  name: 'twitch_chat_messages_deduped_total',
  help: 'Total chat messages dropped due to deduplication'
});
register.registerMetric(chatMessagesDedupedTotal);

const chatRateLimitedTotal = new client.Counter({
  name: 'twitch_chat_rate_limited_total',
  help: 'Total chat messages blocked due to rate limiting'
});
register.registerMetric(chatRateLimitedTotal);

// WebSocket metrics
const wsConnections = new client.Gauge({
  name: 'twitch_websocket_connections',
  help: 'Active WebSocket connections'
});
register.registerMetric(wsConnections);

const wsConnectionsTotal = new client.Counter({
  name: 'twitch_websocket_connections_total',
  help: 'Total WebSocket connections established'
});
register.registerMetric(wsConnectionsTotal);

// Subscription metrics
const subscriptionsTotal = new client.Counter({
  name: 'twitch_subscriptions_total',
  help: 'Total subscriptions created',
  labelNames: ['tier']
});
register.registerMetric(subscriptionsTotal);

const subscriptionsDedupedTotal = new client.Counter({
  name: 'twitch_subscriptions_deduped_total',
  help: 'Total subscription requests deduplicated via idempotency'
});
register.registerMetric(subscriptionsDedupedTotal);

// Circuit breaker metrics
const circuitBreakerState = new client.Gauge({
  name: 'twitch_circuit_breaker_state',
  help: 'Circuit breaker state: 0=closed, 1=half-open, 2=open',
  labelNames: ['name']
});
register.registerMetric(circuitBreakerState);

const circuitBreakerFailures = new client.Counter({
  name: 'twitch_circuit_breaker_failures_total',
  help: 'Total failures tracked by circuit breakers',
  labelNames: ['name']
});
register.registerMetric(circuitBreakerFailures);

// Moderation metrics
const moderationActionsTotal = new client.Counter({
  name: 'twitch_moderation_actions_total',
  help: 'Total moderation actions taken',
  labelNames: ['action', 'channel_id']
});
register.registerMetric(moderationActionsTotal);

// ===================
// Express Middleware
// ===================

function metricsMiddleware(req, res, next) {
  const start = process.hrtime.bigint();

  res.on('finish', () => {
    const duration = Number(process.hrtime.bigint() - start) / 1e9;
    const route = req.route ? req.route.path : req.path;
    const labels = {
      method: req.method,
      route: route,
      status_code: res.statusCode
    };

    httpRequestDuration.observe(labels, duration);
    httpRequestsTotal.inc(labels);
  });

  next();
}

/**
 * Get metrics endpoint handler
 */
async function getMetrics(req, res) {
  res.set('Content-Type', register.contentType);
  res.end(await register.metrics());
}

// ===================
// Metric Helper Functions
// ===================

function incChatMessage(channelId) {
  chatMessagesTotal.inc({ channel_id: String(channelId) });
}

function incChatDeduped() {
  chatMessagesDedupedTotal.inc();
}

function incChatRateLimited() {
  chatRateLimitedTotal.inc();
}

function incWsConnection() {
  wsConnections.inc();
  wsConnectionsTotal.inc();
}

function decWsConnection() {
  wsConnections.dec();
}

function incSubscription(tier) {
  subscriptionsTotal.inc({ tier: String(tier) });
}

function incSubscriptionDeduped() {
  subscriptionsDedupedTotal.inc();
}

function incStreamStart() {
  streamStartsTotal.inc();
  activeStreams.inc();
}

function incStreamEnd() {
  streamEndsTotal.inc();
  activeStreams.dec();
}

function setTotalViewers(count) {
  totalViewers.set(count);
}

function setActiveStreams(count) {
  activeStreams.set(count);
}

function setCircuitBreakerState(name, state) {
  const stateValue = { closed: 0, halfOpen: 1, open: 2 }[state] || 0;
  circuitBreakerState.set({ name }, stateValue);
}

function incCircuitBreakerFailure(name) {
  circuitBreakerFailures.inc({ name });
}

function incModerationAction(action, channelId) {
  moderationActionsTotal.inc({ action, channel_id: String(channelId) });
}

module.exports = {
  register,
  metricsMiddleware,
  getMetrics,
  // Stream metrics
  incStreamStart,
  incStreamEnd,
  setTotalViewers,
  setActiveStreams,
  // Chat metrics
  incChatMessage,
  incChatDeduped,
  incChatRateLimited,
  // WebSocket metrics
  incWsConnection,
  decWsConnection,
  // Subscription metrics
  incSubscription,
  incSubscriptionDeduped,
  // Circuit breaker metrics
  setCircuitBreakerState,
  incCircuitBreakerFailure,
  // Moderation metrics
  incModerationAction
};
