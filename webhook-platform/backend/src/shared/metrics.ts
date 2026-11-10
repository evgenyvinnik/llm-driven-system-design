/**
 * Prometheus metrics. Each process exposes its own registry on /metrics.
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

export const eventsEmitted = new client.Counter({
  name: 'webhooks_events_emitted_total',
  help: 'Event emits, by outcome (created, idempotent_replay, key_conflict)',
  labelNames: ['outcome'],
  registers: [registry],
})

export const deliveriesFannedOut = new client.Counter({
  name: 'webhooks_deliveries_created_total',
  help: 'Deliveries created by fan-out (one per matching endpoint)',
  registers: [registry],
})

export const outboxPublished = new client.Counter({
  name: 'webhooks_outbox_published_total',
  help: 'Outbox rows published to RabbitMQ and confirmed',
  registers: [registry],
})

export const outboxLagSeconds = new client.Gauge({
  name: 'webhooks_outbox_oldest_unpublished_seconds',
  help: 'Age of the oldest unpublished outbox row',
  registers: [registry],
})

export const attemptsTotal = new client.Counter({
  name: 'webhooks_attempts_total',
  help: 'HTTP delivery attempts, by error class and outcome',
  labelNames: ['error_class', 'outcome'],
  registers: [registry],
})

export const attemptLatency = new client.Histogram({
  name: 'webhooks_attempt_duration_seconds',
  help: 'Delivery attempt duration (connect to response), by outcome',
  labelNames: ['outcome'],
  buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 15],
  registers: [registry],
})

export const ticketsHandled = new client.Counter({
  name: 'webhooks_tickets_total',
  help: 'Queue tickets handled by workers, by result (attempted, stale, busy_parked, paused_parked, endpoint_disabled, stolen_lease)',
  labelNames: ['result'],
  registers: [registry],
})

export const schedulerDispatched = new client.Counter({
  name: 'webhooks_scheduler_dispatched_total',
  help: 'Deliveries moved from scheduled to queued by the scheduler, and leases reclaimed',
  labelNames: ['kind'],
  registers: [registry],
})

export const endpointsDisabled = new client.Counter({
  name: 'webhooks_endpoints_disabled_total',
  help: 'Endpoints disabled automatically, by reason',
  labelNames: ['reason'],
  registers: [registry],
})

export const workerInFlight = new client.Gauge({
  name: 'webhooks_worker_in_flight',
  help: 'HTTP requests this worker has in flight',
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
