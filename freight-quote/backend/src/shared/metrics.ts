/**
 * Prometheus metrics. Each process (API, completer, projector) exposes its
 * own registry on /metrics.
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
  buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  registers: [registry],
})

export const quoteDuration = new client.Histogram({
  name: 'fq_quote_duration_seconds',
  help: 'POST /quotes latency by client class and outcome (firm, indicative, unavailable, shed, rate_limited, replayed)',
  labelNames: ['client_class', 'outcome'],
  buckets: [0.025, 0.05, 0.1, 0.2, 0.4, 0.6, 0.8, 1, 1.5, 2, 3, 5],
  registers: [registry],
})

export const dependencyDuration = new client.Histogram({
  name: 'fq_dependency_call_duration_seconds',
  help: 'Dependency call latency as seen by the caller, by dependency and outcome (ok, error, timeout, short_circuit)',
  labelNames: ['dependency', 'outcome', 'caller'],
  buckets: [0.025, 0.05, 0.1, 0.2, 0.4, 0.6, 1, 2, 5],
  registers: [registry],
})

export const breakerState = new client.Gauge({
  name: 'fq_circuit_state',
  help: 'Circuit breaker state per dependency: 0 closed, 1 half-open, 2 open',
  labelNames: ['dependency', 'caller'],
  registers: [registry],
})

export const cacheLookups = new client.Counter({
  name: 'fq_component_cache_lookups_total',
  help: 'Component cache lookups by component and result (hit, miss, stale_version)',
  labelNames: ['dependency', 'result'],
  registers: [registry],
})

export const shedTotal = new client.Counter({
  name: 'fq_shed_total',
  help: 'Requests rejected before work started, by client class and reason (shed, rate_limited)',
  labelNames: ['client_class', 'reason'],
  registers: [registry],
})

export const hedgesTotal = new client.Counter({
  name: 'fq_hedges_total',
  help: 'Hedged dependency requests by dependency and result (fired, won, skipped_budget)',
  labelNames: ['dependency', 'result'],
  registers: [registry],
})

export const coalescedTotal = new client.Counter({
  name: 'fq_coalesced_total',
  help: 'Dependency calls that joined an identical in-flight call instead of making their own',
  labelNames: ['dependency'],
  registers: [registry],
})

export const outboxLag = new client.Gauge({
  name: 'fq_outbox_unpublished',
  help: 'Events committed to the outbox but not yet published to a stream',
  registers: [registry],
})

export const relayPublished = new client.Counter({
  name: 'fq_relay_published_total',
  help: 'Events published by the outbox relay',
  registers: [registry],
})

export const consumerMessages = new client.Counter({
  name: 'fq_consumer_messages_total',
  help: 'Stream messages handled by a consumer group, by outcome (acked, failed, redelivered)',
  labelNames: ['group', 'outcome'],
  registers: [registry],
})

export const eventsHandled = new client.Counter({
  name: 'fq_events_handled_total',
  help: 'Events applied by a consumer, by group, type and result (applied, duplicate, skipped)',
  labelNames: ['group', 'type', 'result'],
  registers: [registry],
})

export const deadLettered = new client.Counter({
  name: 'fq_dead_lettered_total',
  help: 'Messages moved to the dead-letter stream, by group and reason',
  labelNames: ['group', 'reason'],
  registers: [registry],
})

export const consumerLag = new client.Gauge({
  name: 'fq_consumer_lag',
  help: 'Entries not yet delivered to a consumer group, summed over its streams',
  labelNames: ['group'],
  registers: [registry],
})

export const consumerPending = new client.Gauge({
  name: 'fq_consumer_pending',
  help: 'Delivered but unacknowledged entries per consumer group',
  labelNames: ['group'],
  registers: [registry],
})

export const dlqDepth = new client.Gauge({
  name: 'fq_dlq_depth',
  help: 'Entries in the dead-letter stream',
  registers: [registry],
})

export const projectionStaleness = new client.Gauge({
  name: 'fq_projection_staleness_seconds',
  help: 'Seconds between now and the recorded_at of the newest event the projection has applied, when events are waiting',
  labelNames: ['projection'],
  registers: [registry],
})

export const webhookDeliveries = new client.Counter({
  name: 'fq_webhook_deliveries_total',
  help: 'Webhook delivery attempts by result (delivered, failed_attempt, dead)',
  labelNames: ['result'],
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
