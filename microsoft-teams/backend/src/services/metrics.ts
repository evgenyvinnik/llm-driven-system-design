import client from 'prom-client';

const register = new client.Registry();
client.collectDefaultMetrics({ register });

/** HTTP request duration histogram (latency percentiles). */
export const httpRequestDuration = new client.Histogram({
  name: 'http_request_duration_seconds',
  help: 'Duration of HTTP requests in seconds',
  labelNames: ['method', 'route', 'status_code'],
  buckets: [0.01, 0.05, 0.1, 0.5, 1, 5],
  registers: [register],
});

/** HTTP request counter for rate calculation. */
export const httpRequestTotal = new client.Counter({
  name: 'http_requests_total',
  help: 'Total number of HTTP requests',
  labelNames: ['method', 'route', 'status_code'],
  registers: [register],
});

/**
 * Messages created. Deliberately unlabeled: a channel_id label would create one time series per
 * channel, which is unbounded cardinality for a metrics backend.
 */
export const messagesTotal = new client.Counter({
  name: 'messages_total',
  help: 'Total number of messages created',
  registers: [register],
});

/** Sends that matched an earlier clientMessageId and returned the original message. */
export const messageSendReplaysTotal = new client.Counter({
  name: 'message_send_replays_total',
  help: 'Message sends answered from an earlier attempt with the same clientMessageId',
  registers: [register],
});

/** Gauge tracking the number of active SSE connections. */
export const sseConnectionsGauge = new client.Gauge({
  name: 'sse_connections_active',
  help: 'Number of active SSE connections',
  registers: [register],
});

/** Event frames written to SSE clients, live or replayed. */
export const sseEventsSentTotal = new client.Counter({
  name: 'sse_events_sent_total',
  help: 'Channel events written to SSE clients',
  registers: [register],
});

/** Events sent to reconnecting clients from the channel_events log. */
export const sseReplayedEventsTotal = new client.Counter({
  name: 'sse_replayed_events_total',
  help: 'Channel events replayed to reconnecting SSE clients',
  registers: [register],
});

/** Clients told to reload history because their gap could not be replayed. */
export const sseResyncsTotal = new client.Counter({
  name: 'sse_resyncs_total',
  help: 'Resync instructions sent to SSE clients',
  labelNames: ['reason'],
  registers: [register],
});

/** Times an instance read events from the log that pub/sub had not (yet) delivered. */
export const sseGapFillsTotal = new client.Counter({
  name: 'sse_gap_fills_total',
  help: 'Gaps in pub/sub delivery filled from the channel_events log',
  labelNames: ['trigger'],
  registers: [register],
});

/** Publishes that failed after the write committed (delivery then relies on the log). */
export const pubsubPublishFailuresTotal = new client.Counter({
  name: 'pubsub_publish_failures_total',
  help: 'Redis publishes that failed after the event was committed',
  registers: [register],
});

/** Counter tracking total presence heartbeat updates. */
export const presenceUpdatesTotal = new client.Counter({
  name: 'presence_updates_total',
  help: 'Total number of presence heartbeats',
  registers: [register],
});

export { register };
