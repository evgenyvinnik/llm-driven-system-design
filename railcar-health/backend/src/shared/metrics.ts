/**
 * Prometheus metrics. The API, the analyzer and the workers each expose their
 * own registry on /metrics (ANALYZER_PORT, WORKERS_PORT).
 * @module shared/metrics
 */
import type { NextFunction, Request, Response } from 'express'
import client from 'prom-client'

export const registry = new client.Registry()
client.collectDefaultMetrics({ register: registry })

export const httpDuration = new client.Histogram({
  name: 'http_request_duration_seconds',
  help: 'HTTP request duration',
  labelNames: ['method', 'route', 'status'],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5],
  registers: [registry],
})

export const passesIngested = new client.Counter({
  name: 'rh_passes_ingested_total',
  help: 'Detector passes received by the ingest endpoint, by outcome (accepted, duplicate)',
  labelNames: ['outcome'],
  registers: [registry],
})

export const ingestLagMinutes = new client.Histogram({
  name: 'rh_ingest_lag_minutes',
  help: 'Domain-time delay between a train passing a detector and the pass reaching the API',
  buckets: [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 240, 480],
  registers: [registry],
})

export const passesProcessed = new client.Counter({
  name: 'rh_passes_processed_total',
  help: 'Passes handled by the analyzer, by outcome (processed, already_processed, awaiting_consist, unresolved, failed) and lane',
  labelNames: ['outcome', 'lane'],
  registers: [registry],
})

export const processSeconds = new client.Histogram({
  name: 'rh_pass_process_seconds',
  help: 'Analyzer time to resolve, trend and score one pass, by lane',
  labelNames: ['lane'],
  buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5],
  registers: [registry],
})

export const alertTransitions = new client.Counter({
  name: 'rh_alert_transitions_total',
  help: 'Alerts opened or escalated, by tier and lateness',
  labelNames: ['transition', 'tier', 'late'],
  registers: [registry],
})

export const ackEscalations = new client.Counter({
  name: 'rh_ack_escalations_total',
  help: 'Alerts escalated to the next role, by reason (ack_overdue, approaching_yard)',
  labelNames: ['reason'],
  registers: [registry],
})

export const streamRedeliveries = new client.Counter({
  name: 'rh_stream_redeliveries_total',
  help: 'Broker messages claimed from a stalled consumer, retried after a failure, or dead-lettered, by group',
  labelNames: ['group', 'kind'],
  registers: [registry],
})

export const eventsAppended = new client.Counter({
  name: 'rh_events_appended_total',
  help: 'Events appended to the event store, by type',
  labelNames: ['type'],
  registers: [registry],
})

export const relayPublished = new client.Counter({
  name: 'rh_relay_published_total',
  help: 'Events the relay published from the store to a broker stream, by family',
  labelNames: ['family'],
  registers: [registry],
})

export const relayLag = new client.Gauge({
  name: 'rh_relay_lag_events',
  help: 'Events committed to the store but not yet published to the broker',
  registers: [registry],
})

export const consumerEvents = new client.Counter({
  name: 'rh_consumer_events_total',
  help: 'Messages handled by consumer groups, by outcome (processed, duplicate, skipped, failed, dead_lettered)',
  labelNames: ['group', 'outcome'],
  registers: [registry],
})

export const consumerHandleSeconds = new client.Histogram({
  name: 'rh_consumer_handle_seconds',
  help: 'Time to handle one message, including its transaction, by group',
  labelNames: ['group'],
  buckets: [0.002, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5],
  registers: [registry],
})

export const consumerLag = new client.Gauge({
  name: 'rh_consumer_lag',
  help: 'Messages on a broker stream not yet delivered to a group, plus delivered but unacknowledged',
  labelNames: ['group', 'stream'],
  registers: [registry],
})

export const dlqDepthGauge = new client.Gauge({
  name: 'rh_dlq_depth',
  help: 'Messages waiting in the dead-letter stream',
  registers: [registry],
})

export const projectionStaleness = new client.Gauge({
  name: 'rh_projection_staleness_seconds',
  help: 'Age of the oldest committed event a projection (or any group) has not applied yet; 0 when caught up',
  labelNames: ['group'],
  registers: [registry],
})

export const eventsPerSecond = new client.Gauge({
  name: 'rh_events_per_second',
  help: 'Events committed to the store per second, averaged over the last 10 seconds',
  registers: [registry],
})

export const timersFired = new client.Counter({
  name: 'rh_timers_fired_total',
  help: 'Process-manager timers fired, by kind and result',
  labelNames: ['kind', 'result'],
  registers: [registry],
})

export const sseConnections = new client.Gauge({
  name: 'rh_sse_connections',
  help: 'Open live-update streams on this API instance',
  registers: [registry],
})

export function httpMetrics(req: Request, res: Response, next: NextFunction): void {
  const end = httpDuration.startTimer()
  res.on('close', () => {
    // Route patterns, not raw paths, keep label cardinality bounded.
    const route = req.route?.path ? `${req.baseUrl}${req.route.path}` : 'unmatched'
    end({ method: req.method, route, status: String(res.statusCode) })
  })
  next()
}

export async function metricsHandler(_req: Request, res: Response): Promise<void> {
  res.set('Content-Type', registry.contentType)
  res.end(await registry.metrics())
}
