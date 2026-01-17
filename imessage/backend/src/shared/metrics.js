import client from 'prom-client';

// Create a Registry to register the metrics
const register = new client.Registry();

// Add default metrics (CPU, memory, etc.)
client.collectDefaultMetrics({ register });

// Message metrics
export const messagesTotal = new client.Counter({
  name: 'imessage_messages_total',
  help: 'Total number of messages sent',
  labelNames: ['status', 'content_type'],
  registers: [register],
});

export const messageDeliveryDuration = new client.Histogram({
  name: 'imessage_message_delivery_duration_seconds',
  help: 'Time taken to deliver a message',
  labelNames: ['status'],
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [register],
});

export const messageDeliveryStatus = new client.Counter({
  name: 'imessage_message_delivery_status_total',
  help: 'Message delivery status counts',
  labelNames: ['status'], // 'delivered', 'failed', 'pending', 'duplicate'
  registers: [register],
});

// Sync metrics
export const syncLatency = new client.Histogram({
  name: 'imessage_sync_latency_seconds',
  help: 'Message sync latency between devices',
  labelNames: ['conversation_type'],
  buckets: [0.1, 0.5, 1, 2.5, 5, 10, 30, 60],
  registers: [register],
});

export const syncOperationsTotal = new client.Counter({
  name: 'imessage_sync_operations_total',
  help: 'Total number of sync operations',
  labelNames: ['status'],
  registers: [register],
});

// Conversation metrics
export const conversationsActive = new client.Gauge({
  name: 'imessage_conversations_active',
  help: 'Number of active conversations with recent messages',
  registers: [register],
});

// Connection metrics
export const websocketConnections = new client.Gauge({
  name: 'imessage_websocket_connections',
  help: 'Current number of WebSocket connections',
  registers: [register],
});

// Cache metrics
export const cacheHits = new client.Counter({
  name: 'imessage_cache_hits_total',
  help: 'Cache hit count',
  labelNames: ['cache_type'], // 'conversation', 'device_keys', 'session'
  registers: [register],
});

export const cacheMisses = new client.Counter({
  name: 'imessage_cache_misses_total',
  help: 'Cache miss count',
  labelNames: ['cache_type'],
  registers: [register],
});

// Rate limiting metrics
export const rateLimitExceeded = new client.Counter({
  name: 'imessage_rate_limit_exceeded_total',
  help: 'Number of rate limit exceeded events',
  labelNames: ['endpoint', 'user_id'],
  registers: [register],
});

// Idempotency metrics
export const idempotentRequests = new client.Counter({
  name: 'imessage_idempotent_requests_total',
  help: 'Count of idempotent request handling',
  labelNames: ['result'], // 'new', 'duplicate', 'error'
  registers: [register],
});

// Auth metrics
export const authAttempts = new client.Counter({
  name: 'imessage_auth_attempts_total',
  help: 'Authentication attempt counts',
  labelNames: ['result'], // 'success', 'failure'
  registers: [register],
});

// Database metrics
export const dbQueryDuration = new client.Histogram({
  name: 'imessage_db_query_duration_seconds',
  help: 'Database query duration',
  labelNames: ['operation'],
  buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 5],
  registers: [register],
});

// Export the register for the /metrics endpoint
export { register };

// Metrics endpoint handler
export async function metricsHandler(req, res) {
  try {
    res.set('Content-Type', register.contentType);
    res.end(await register.metrics());
  } catch (err) {
    res.status(500).end(err.message);
  }
}
