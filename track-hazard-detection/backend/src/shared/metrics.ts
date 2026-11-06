/**
 * Prometheus metrics. Every service exposes its own registry on /metrics
 * (the API on its HTTP port, workers on their ops port).
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

export const edgeEventsIngested = new client.Counter({
  name: 'th_edge_events_ingested_total',
  help: 'Edge events received by ingest, by type, lane and outcome (accepted, duplicate)',
  labelNames: ['type', 'lane', 'outcome'],
  registers: [registry],
})

export const ingestLagSeconds = new client.Histogram({
  name: 'th_ingest_lag_seconds',
  help: 'Event time to ingest time: includes time buffered at the edge while a gateway was offline',
  labelNames: ['lane'],
  buckets: [0.1, 0.25, 0.5, 1, 2, 5, 10, 30, 60, 120, 600, 3600],
  registers: [registry],
})

export const outboxPublished = new client.Counter({
  name: 'th_outbox_published_total',
  help: 'Outbox rows published to streams, by lane',
  labelNames: ['lane'],
  registers: [registry],
})

export const outboxBacklog = new client.Gauge({
  name: 'th_outbox_backlog',
  help: 'Committed outbox rows not yet published, by lane',
  labelNames: ['lane'],
  registers: [registry],
})

export const consumerProcessed = new client.Counter({
  name: 'th_consumer_messages_total',
  help: 'Stream messages handled, by consumer group, topic and outcome (ok, duplicate, retry, dead_lettered)',
  labelNames: ['group', 'topic', 'outcome'],
  registers: [registry],
})

export const consumerSeconds = new client.Histogram({
  name: 'th_consumer_handle_seconds',
  help: 'Time to handle one message, by group and topic',
  labelNames: ['group', 'topic'],
  buckets: [0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1],
  registers: [registry],
})

export const consumerLag = new client.Gauge({
  name: 'th_consumer_lag',
  help: 'Entries not yet delivered to the group, summed over partitions (Valkey XINFO GROUPS lag)',
  labelNames: ['group', 'topic'],
  registers: [registry],
})

export const consumerPending = new client.Gauge({
  name: 'th_consumer_pending',
  help: 'Delivered but unacknowledged entries, summed over partitions',
  labelNames: ['group', 'topic'],
  registers: [registry],
})

export const dlqDepth = new client.Gauge({
  name: 'th_dlq_depth',
  help: 'Dead letters not yet redriven or discarded',
  registers: [registry],
})

export const hazardTransitions = new client.Counter({
  name: 'th_hazard_events_total',
  help: 'Hazard events appended by the correlator, by type and lateness',
  labelNames: ['type', 'late'],
  registers: [registry],
})

export const decisionLatency = new client.Histogram({
  name: 'th_edge_to_decision_seconds',
  help: 'Edge event time to correlator decision, by lane and lateness',
  labelNames: ['lane', 'late'],
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 30, 60, 300],
  registers: [registry],
})

export const detectionToAlert = new client.Histogram({
  name: 'th_detection_to_alert_seconds',
  help: 'Edge detection (event time) to the alert delivered on the dispatcher console, by lane and lateness',
  labelNames: ['lane', 'late'],
  buckets: [0.25, 0.5, 1, 2, 3, 5, 10, 30, 60, 300],
  registers: [registry],
})

export const escalations = new client.Counter({
  name: 'th_alert_escalations_total',
  help: 'Alert escalations, by reason',
  labelNames: ['reason'],
  registers: [registry],
})

export const notifications = new client.Counter({
  name: 'th_notifications_total',
  help: 'Simulated notification attempts, by channel and outcome',
  labelNames: ['channel', 'outcome'],
  registers: [registry],
})

export const projectionStaleness = new client.Gauge({
  name: 'th_projection_staleness_seconds',
  help: 'Recorded time of the newest event in the store minus that of the newest event the projection applied',
  labelNames: ['projection'],
  registers: [registry],
})

export const sseConnections = new client.Gauge({
  name: 'th_sse_connections',
  help: 'Open live-update streams on this API instance',
  registers: [registry],
})

export function httpMetrics(req: Request, res: Response, next: NextFunction): void {
  const end = httpDuration.startTimer()
  res.on('close', () => {
    const route = req.route?.path ? `${req.baseUrl}${req.route.path}` : 'unmatched'
    end({ method: req.method, route, status: String(res.statusCode) })
  })
  next()
}

export async function metricsHandler(_req: Request, res: Response): Promise<void> {
  res.set('Content-Type', registry.contentType)
  res.end(await registry.metrics())
}
