/**
 * Prometheus metrics. Each process exposes its own registry on /metrics.
 * The latency split (queue, time to first token, tokens/sec, total) is
 * recorded by the dispatcher, which sees every request's lifecycle, so queue
 * delay is never mistaken for slow execution.
 * @module shared/metrics
 */
import type { NextFunction, Request, Response } from 'express'
import client from 'prom-client'

export const registry = new client.Registry()
client.collectDefaultMetrics({ register: registry })

export const httpDuration = new client.Histogram({
  name: 'http_request_duration_seconds',
  help: 'HTTP request duration (streams included, so long tails are expected on /v1/messages)',
  labelNames: ['method', 'route', 'status'],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30],
  registers: [registry],
})

// Gateway
export const admissions = new client.Counter({
  name: 'inference_admission_total',
  help: 'Admission decisions at the edge, by class and outcome (ok, rate_limited_tokens, rate_limited_requests, tenant_queue_full, overloaded, too_large)',
  labelNames: ['class', 'outcome'],
  registers: [registry],
})

export const cancellations = new client.Counter({
  name: 'inference_cancellations_total',
  help: 'Cancellation attempts by reason and who won the race (cancel or the terminal state already reached)',
  labelNames: ['reason', 'won'],
  registers: [registry],
})

// Dispatcher
export const queueSeconds = new client.Histogram({
  name: 'inference_queue_seconds',
  help: 'Time from admission until a backend accepted the request: batching wait, waiting for slots, re-routes',
  labelNames: ['class'],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30],
  registers: [registry],
})

export const ttftSeconds = new client.Histogram({
  name: 'inference_ttft_seconds',
  help: 'Backend time to first token (from acceptance to first token: prefill), by class and prefix-cache outcome',
  labelNames: ['class', 'cache'],
  buckets: [0.05, 0.1, 0.2, 0.3, 0.5, 0.75, 1, 1.5, 2, 3, 5],
  registers: [registry],
})

export const tokensPerSecond = new client.Histogram({
  name: 'inference_tokens_per_second',
  help: 'Decode speed per request after the first token',
  labelNames: ['class'],
  buckets: [5, 10, 15, 20, 25, 30, 35, 40, 50, 75, 100],
  registers: [registry],
})

export const totalSeconds = new client.Histogram({
  name: 'inference_total_seconds',
  help: 'End-to-end time from admission to the terminal state',
  labelNames: ['class', 'status'],
  buckets: [0.1, 0.25, 0.5, 1, 2, 4, 8, 15, 30, 60],
  registers: [registry],
})

export const batchSize = new client.Histogram({
  name: 'inference_batch_size',
  help: 'Requests per dispatched batch, by class and trigger (full, max_wait, deadline)',
  labelNames: ['class', 'trigger'],
  buckets: [1, 2, 3, 4, 6, 8, 16, 32, 64, 100],
  registers: [registry],
})

export const queueDepth = new client.Gauge({
  name: 'inference_queue_depth',
  help: 'Queued requests per priority class',
  labelNames: ['class'],
  registers: [registry],
})

export const slotsInUse = new client.Gauge({
  name: 'inference_backend_slots_in_use',
  help: 'Slots in use per backend, as last reported',
  labelNames: ['backend'],
  registers: [registry],
})

export const routeDecisions = new client.Counter({
  name: 'inference_route_total',
  help: 'Routing decisions: primary (the prefix key owner) or spill (bounded load, draining or down)',
  labelNames: ['affinity'],
  registers: [registry],
})

export const reroutes = new client.Counter({
  name: 'inference_reroutes_total',
  help: 'Requests put back in the queue before output started, by reason',
  labelNames: ['reason'],
  registers: [registry],
})

export const finished = new client.Counter({
  name: 'inference_requests_finished_total',
  help: 'Requests reaching a terminal state, by status and error type',
  labelNames: ['status', 'error_type'],
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
