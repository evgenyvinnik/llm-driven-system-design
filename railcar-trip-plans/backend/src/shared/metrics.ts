/**
 * Prometheus metrics. Every process exposes its own registry on /metrics (the API on its port, the relay
 * and each consumer on its health port). Consumer lag, pending counts, DLQ depth and projection staleness
 * are read from Valkey by the API and exported as gauges at scrape time.
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

export const eventsIngested = new client.Counter({
  name: 'tp_events_ingested_total',
  help: 'Events received at ingest, by type and outcome (accepted, duplicate, rejected)',
  labelNames: ['type', 'outcome'],
  registers: [registry],
})

export const eventsAppended = new client.Counter({
  name: 'tp_events_appended_total',
  help: 'Events appended to the event store, by type',
  labelNames: ['type'],
  registers: [registry],
})

export const ingestLagMinutes = new client.Histogram({
  name: 'tp_ingest_lag_minutes',
  help: 'recorded_at - occurred_at for ingested facts (how late producers report)',
  labelNames: ['producer_kind'],
  buckets: [0.5, 1, 5, 15, 30, 60, 120, 240, 480, 960],
  registers: [registry],
})

export const eventsPublished = new client.Counter({
  name: 'tp_events_published_total',
  help: 'Events published by the outbox relay to a stream partition',
  labelNames: ['topic'],
  registers: [registry],
})

export const outboxBacklog = new client.Gauge({
  name: 'tp_outbox_backlog',
  help: 'Committed events not yet published by the relay',
  registers: [registry],
})

export const messagesHandled = new client.Counter({
  name: 'tp_consumer_messages_total',
  help: 'Messages handled by a consumer group, by outcome (processed, duplicate, skipped, failed, dead_lettered)',
  labelNames: ['group', 'outcome'],
  registers: [registry],
})

export const handlerSeconds = new client.Histogram({
  name: 'tp_consumer_handler_seconds',
  help: 'Time to handle one message inside its transaction',
  labelNames: ['group'],
  buckets: [0.002, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5],
  registers: [registry],
})

export const consumerLag = new client.Gauge({
  name: 'tp_consumer_lag',
  help: 'Messages in a partition not yet delivered to the group (XINFO GROUPS lag)',
  labelNames: ['group', 'stream'],
  registers: [registry],
})

export const consumerPending = new client.Gauge({
  name: 'tp_consumer_pending',
  help: 'Messages delivered to the group but not acknowledged',
  labelNames: ['group', 'stream'],
  registers: [registry],
})

export const projectionStaleness = new client.Gauge({
  name: 'tp_projection_staleness_seconds',
  help: 'Age of the oldest message a consumer group has not finished (0 when caught up)',
  labelNames: ['group'],
  registers: [registry],
})

export const dlqDepth = new client.Gauge({
  name: 'tp_dlq_depth',
  help: 'Messages parked in a consumer group dead-letter stream',
  labelNames: ['group'],
  registers: [registry],
})

export const sagaTransitions = new client.Counter({
  name: 'tp_replan_saga_transitions_total',
  help: 'Replanning saga state transitions',
  labelNames: ['to'],
  registers: [registry],
})

export const digestsSent = new client.Counter({
  name: 'tp_digests_sent_total',
  help: 'Shipper digests sent, and the items they collapsed',
  labelNames: ['kind'],
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
