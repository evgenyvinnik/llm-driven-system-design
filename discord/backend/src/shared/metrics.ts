/**
 * Prometheus Metrics Module
 *
 * Provides application metrics for monitoring and alerting.
 * Metrics are exposed via /metrics endpoint in Prometheus format.
 *
 * WHY Metrics with Alert Thresholds Enable Proactive Monitoring:
 * - Early detection of capacity issues (connection exhaustion, queue buildup)
 * - Performance regression detection (latency increases)
 * - Capacity planning data (throughput trends)
 * - Incident response acceleration (quick diagnosis via dashboards)
 */

import client from 'prom-client';
import { server, alertThresholds } from './config.js';

// ============================================================================
// Prometheus Registry Setup
// ============================================================================

/** Custom registry for Baby Discord metrics */
export const metricsRegistry = new client.Registry();

// Add default metrics (CPU, memory, event loop, etc.)
client.collectDefaultMetrics({
  register: metricsRegistry,
  prefix: 'babydiscord_',
  labels: { instance: server.instanceId },
});

// ============================================================================
// Connection Metrics
// ============================================================================

/**
 * Gauge for active WebSocket/SSE connections.
 * Used to monitor real-time connection capacity.
 */
export const activeConnections = new client.Gauge({
  name: 'babydiscord_active_connections',
  help: 'Number of active client connections',
  labelNames: ['transport', 'instance'],
  registers: [metricsRegistry],
});

/**
 * Counter for total connections established.
 * Used to track connection churn and growth.
 */
export const totalConnections = new client.Counter({
  name: 'babydiscord_connections_total',
  help: 'Total number of connections established',
  labelNames: ['transport', 'instance'],
  registers: [metricsRegistry],
});

/**
 * Counter for connection errors.
 * Spikes indicate connectivity or authentication issues.
 */
export const connectionErrors = new client.Counter({
  name: 'babydiscord_connection_errors_total',
  help: 'Total number of connection errors',
  labelNames: ['transport', 'error_type', 'instance'],
  registers: [metricsRegistry],
});

// ============================================================================
// Message Metrics
// ============================================================================

/**
 * Counter for total messages sent.
 * Primary throughput metric for the chat system.
 */
export const messagesSent = new client.Counter({
  name: 'babydiscord_messages_sent_total',
  help: 'Total number of messages sent',
  labelNames: ['room', 'instance'],
  registers: [metricsRegistry],
});

/**
 * Counter for total messages received via pub/sub.
 * Tracks cross-instance message delivery.
 */
export const messagesReceived = new client.Counter({
  name: 'babydiscord_messages_received_total',
  help: 'Total number of messages received from pub/sub',
  labelNames: ['room', 'instance'],
  registers: [metricsRegistry],
});

/**
 * Histogram for message delivery latency.
 * Measures time from message send to delivery confirmation.
 */
export const messageDeliveryLatency = new client.Histogram({
  name: 'babydiscord_message_delivery_latency_seconds',
  help: 'Message delivery latency in seconds',
  labelNames: ['transport', 'instance'],
  buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1],
  registers: [metricsRegistry],
});

// ============================================================================
// Pub/Sub Metrics
// ============================================================================

/**
 * Histogram for pub/sub publish latency.
 * Measures time to publish messages to Redis/Valkey.
 */
export const pubsubPublishLatency = new client.Histogram({
  name: 'babydiscord_pubsub_publish_latency_seconds',
  help: 'Pub/sub publish latency in seconds',
  labelNames: ['instance'],
  buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1],
  registers: [metricsRegistry],
});

/**
 * Gauge for pub/sub connection status.
 * 1 = connected, 0 = disconnected.
 */
export const pubsubConnectionStatus = new client.Gauge({
  name: 'babydiscord_pubsub_connected',
  help: 'Pub/sub connection status (1=connected, 0=disconnected)',
  labelNames: ['instance'],
  registers: [metricsRegistry],
});

/**
 * Gauge for number of subscribed channels.
 * Indicates room coverage for this instance.
 */
export const subscribedChannels = new client.Gauge({
  name: 'babydiscord_pubsub_subscribed_channels',
  help: 'Number of pub/sub channels subscribed to',
  labelNames: ['instance'],
  registers: [metricsRegistry],
});

// ============================================================================
// Database Metrics
// ============================================================================

/**
 * Gauge for database connection pool size.
 * Monitors pool utilization.
 */
export const dbPoolSize = new client.Gauge({
  name: 'babydiscord_db_pool_connections',
  help: 'Database connection pool size',
  labelNames: ['state', 'instance'], // state: idle, active, waiting
  registers: [metricsRegistry],
});

/**
 * Histogram for database query latency.
 * Identifies slow queries and database performance issues.
 */
export const dbQueryLatency = new client.Histogram({
  name: 'babydiscord_db_query_latency_seconds',
  help: 'Database query latency in seconds',
  labelNames: ['operation', 'instance'], // operation: select, insert, update, delete
  buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5],
  registers: [metricsRegistry],
});

/**
 * Counter for database errors.
 * Tracks database connectivity and query issues.
 */
export const dbErrors = new client.Counter({
  name: 'babydiscord_db_errors_total',
  help: 'Total number of database errors',
  labelNames: ['operation', 'error_type', 'instance'],
  registers: [metricsRegistry],
});

// ============================================================================
// Room Metrics
// ============================================================================

/**
 * Gauge for number of active rooms.
 * Tracks room growth over time.
 */
export const activeRooms = new client.Gauge({
  name: 'babydiscord_active_rooms',
  help: 'Number of active rooms',
  labelNames: ['instance'],
  registers: [metricsRegistry],
});

/**
 * Gauge for room membership.
 * Tracks how many users are in each room.
 */
export const roomMembership = new client.Gauge({
  name: 'babydiscord_room_members',
  help: 'Number of members in each room',
  labelNames: ['room', 'instance'],
  registers: [metricsRegistry],
});

// ============================================================================
// Cache Metrics
// ============================================================================

/**
 * Counter for history buffer hits.
 * High hit rates indicate effective caching.
 */
export const historyBufferHits = new client.Counter({
  name: 'babydiscord_history_buffer_hits_total',
  help: 'Total number of history buffer cache hits',
  labelNames: ['instance'],
  registers: [metricsRegistry],
});

/**
 * Counter for history buffer misses.
 * High miss rates may indicate memory pressure.
 */
export const historyBufferMisses = new client.Counter({
  name: 'babydiscord_history_buffer_misses_total',
  help: 'Total number of history buffer cache misses',
  labelNames: ['instance'],
  registers: [metricsRegistry],
});

/**
 * Gauge for history buffer size (number of rooms cached).
 */
export const historyBufferSize = new client.Gauge({
  name: 'babydiscord_history_buffer_rooms',
  help: 'Number of rooms in history buffer',
  labelNames: ['instance'],
  registers: [metricsRegistry],
});

// ============================================================================
// Cleanup Job Metrics
// ============================================================================

/**
 * Counter for cleanup job runs.
 * Tracks retention policy enforcement.
 */
export const cleanupJobRuns = new client.Counter({
  name: 'babydiscord_cleanup_job_runs_total',
  help: 'Total number of cleanup job runs',
  labelNames: ['status', 'instance'], // status: success, failure
  registers: [metricsRegistry],
});

/**
 * Gauge for last cleanup job timestamp.
 * Monitors cleanup job health.
 */
export const lastCleanupTimestamp = new client.Gauge({
  name: 'babydiscord_cleanup_last_run_timestamp',
  help: 'Unix timestamp of last cleanup job run',
  labelNames: ['instance'],
  registers: [metricsRegistry],
});

/**
 * Counter for messages deleted by cleanup.
 * Tracks storage reclamation.
 */
export const messagesDeleted = new client.Counter({
  name: 'babydiscord_messages_deleted_total',
  help: 'Total number of messages deleted by cleanup',
  labelNames: ['instance'],
  registers: [metricsRegistry],
});

// ============================================================================
// Command Metrics
// ============================================================================

/**
 * Counter for commands executed.
 * Tracks usage patterns.
 */
export const commandsExecuted = new client.Counter({
  name: 'babydiscord_commands_executed_total',
  help: 'Total number of commands executed',
  labelNames: ['command', 'status', 'instance'], // status: success, failure
  registers: [metricsRegistry],
});

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Record a connection event.
 *
 * @param transport - 'tcp' or 'http'
 * @param delta - 1 for connect, -1 for disconnect
 */
export function recordConnection(transport: 'tcp' | 'http', delta: 1 | -1): void {
  const labels = { transport, instance: server.instanceId };
  activeConnections.labels(labels).inc(delta);
  if (delta === 1) {
    totalConnections.labels(labels).inc();
  }
}

/**
 * Record a message sent.
 *
 * @param room - Room name
 */
export function recordMessageSent(room: string): void {
  messagesSent.labels({ room, instance: server.instanceId }).inc();
}

/**
 * Record a pub/sub publish with latency.
 *
 * @param startTime - High-resolution start time from process.hrtime.bigint()
 */
export function recordPubsubPublish(startTime: bigint): void {
  const latencyMs = Number(process.hrtime.bigint() - startTime) / 1_000_000;
  pubsubPublishLatency.labels({ instance: server.instanceId }).observe(latencyMs / 1000);

  // Check thresholds and log if exceeded
  if (latencyMs > alertThresholds.pubsubLatency.critical) {
    // This will be logged by the caller with appropriate context
  }
}

/**
 * Record a database query with latency.
 *
 * @param operation - 'select', 'insert', 'update', 'delete'
 * @param startTime - High-resolution start time
 */
export function recordDbQuery(operation: string, startTime: bigint): void {
  const latencyMs = Number(process.hrtime.bigint() - startTime) / 1_000_000;
  dbQueryLatency.labels({ operation, instance: server.instanceId }).observe(latencyMs / 1000);
}

/**
 * Update database pool metrics.
 *
 * @param idle - Number of idle connections
 * @param active - Number of active connections
 * @param waiting - Number of waiting queries
 */
export function updateDbPoolMetrics(idle: number, active: number, waiting: number): void {
  const labels = { instance: server.instanceId };
  dbPoolSize.labels({ ...labels, state: 'idle' }).set(idle);
  dbPoolSize.labels({ ...labels, state: 'active' }).set(active);
  dbPoolSize.labels({ ...labels, state: 'waiting' }).set(waiting);
}

/**
 * Get all metrics in Prometheus format.
 *
 * @returns Promise resolving to metrics string
 */
export async function getMetrics(): Promise<string> {
  return metricsRegistry.metrics();
}

/**
 * Get content type for metrics endpoint.
 */
export function getMetricsContentType(): string {
  return metricsRegistry.contentType;
}

export default {
  metricsRegistry,
  activeConnections,
  totalConnections,
  connectionErrors,
  messagesSent,
  messagesReceived,
  messageDeliveryLatency,
  pubsubPublishLatency,
  pubsubConnectionStatus,
  subscribedChannels,
  dbPoolSize,
  dbQueryLatency,
  dbErrors,
  activeRooms,
  roomMembership,
  historyBufferHits,
  historyBufferMisses,
  historyBufferSize,
  cleanupJobRuns,
  lastCleanupTimestamp,
  messagesDeleted,
  commandsExecuted,
  recordConnection,
  recordMessageSent,
  recordPubsubPublish,
  recordDbQuery,
  updateDbPoolMetrics,
  getMetrics,
  getMetricsContentType,
};
