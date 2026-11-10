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
  name: 'evals_runs_created_total',
  help: 'Run creations, by outcome (created, idempotent_replay, key_conflict)',
  labelNames: ['outcome'],
  registers: [registry],
})

export const tasksFinished = new client.Counter({
  name: 'evals_tasks_finished_total',
  help: 'Generation attempts by outcome (succeeded, retry_scheduled, errored, cancelled, superseded)',
  labelNames: ['outcome', 'error'],
  registers: [registry],
})

export const scoresFinished = new client.Counter({
  name: 'evals_scores_finished_total',
  help: 'Score tasks by scorer kind and outcome',
  labelNames: ['kind', 'outcome'],
  registers: [registry],
})

export const claimDuration = new client.Histogram({
  name: 'evals_claim_duration_seconds',
  help: 'Time for one SKIP LOCKED claim transaction',
  labelNames: ['kind', 'result'],
  buckets: [0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25],
  registers: [registry],
})

export const modelLatency = new client.Histogram({
  name: 'evals_model_call_seconds',
  help: 'Model call latency split into phases (queue, ttft, generation)',
  labelNames: ['phase'],
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 30],
  registers: [registry],
})

export const leasesReclaimed = new client.Counter({
  name: 'evals_leases_reclaimed_total',
  help: 'Tasks re-claimed after their lease expired (a worker died or stalled)',
  labelNames: ['kind'],
  registers: [registry],
})

export const workerInFlight = new client.Gauge({
  name: 'evals_worker_in_flight',
  help: 'Tasks this worker is executing',
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
