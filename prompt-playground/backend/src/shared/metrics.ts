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

export const runsCreated = new client.Counter({
  name: 'playground_runs_created_total',
  help: 'Runs accepted by the API',
  labelNames: ['model'],
  registers: [registry],
})

export const runsFinished = new client.Counter({
  name: 'playground_runs_finished_total',
  help: 'Runs reaching a terminal state',
  labelNames: ['model', 'status'],
  registers: [registry],
})

export const runQueueSeconds = new client.Histogram({
  name: 'playground_run_queue_seconds',
  help: 'Time from run creation to an executor claiming it',
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 30],
  registers: [registry],
})

export const runTtftSeconds = new client.Histogram({
  name: 'playground_run_ttft_seconds',
  help: 'Time from claim to first output token',
  labelNames: ['model'],
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 5],
  registers: [registry],
})

export const runsInFlight = new client.Gauge({
  name: 'playground_runs_in_flight',
  help: 'Runs currently executing in this executor',
  registers: [registry],
})

export const sseConnections = new client.Gauge({
  name: 'playground_sse_connections',
  help: 'Open run event streams on this API instance',
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
