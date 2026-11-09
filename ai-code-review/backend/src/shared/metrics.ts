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

export const webhooksReceived = new client.Counter({
  name: 'acr_webhooks_total',
  help: 'Webhook deliveries by outcome (applied, duplicate, bad_signature, replay, stale)',
  labelNames: ['event', 'outcome'],
  registers: [registry],
})

export const runsFinished = new client.Counter({
  name: 'acr_runs_finished_total',
  help: 'Review runs by final status and kind',
  labelNames: ['status', 'kind'],
  registers: [registry],
})

export const decisionsMade = new client.Counter({
  name: 'acr_decisions_total',
  help: 'Decisions by mode, outcome and reason code',
  labelNames: ['mode', 'outcome', 'reason'],
  registers: [registry],
})

export const modelOverrules = new client.Counter({
  name: 'acr_model_overruled_total',
  help: 'A model approve the gate refused. A spike here is the injection alarm.',
  registers: [registry],
})

export const toolRequests = new client.Counter({
  name: 'acr_tool_requests_total',
  help: 'Agent tool requests by tool and result (allowed, denied)',
  labelNames: ['tool', 'result'],
  registers: [registry],
})

export const postsFinished = new client.Counter({
  name: 'acr_posts_total',
  help: 'Poster outcomes by kind and result (posted, stale_rejected, recheck_failed, cancelled, failed, dismissed)',
  labelNames: ['kind', 'result'],
  registers: [registry],
})

export const modelLatency = new client.Histogram({
  name: 'acr_model_call_seconds',
  help: 'Model call latency split into phases (queue, ttft, generation)',
  labelNames: ['phase'],
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 30],
  registers: [registry],
})

export const leasesReclaimed = new client.Counter({
  name: 'acr_leases_reclaimed_total',
  help: 'Runs re-claimed after their lease expired (a worker died or stalled)',
  registers: [registry],
})

export const reconcilerRepairs = new client.Counter({
  name: 'acr_reconciler_repairs_total',
  help: 'Head changes found by the reconciler rather than a webhook',
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
