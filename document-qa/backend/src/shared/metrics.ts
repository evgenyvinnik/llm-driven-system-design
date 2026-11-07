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
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 10],
  registers: [registry],
})

export const uploads = new client.Counter({
  name: 'docqa_uploads_total',
  help: 'Upload requests by outcome (created, new_version, duplicate, unchanged, idempotent_replay, rejected)',
  labelNames: ['outcome'],
  registers: [registry],
})

export const jobOutcomes = new client.Counter({
  name: 'docqa_job_attempts_total',
  help: 'Pipeline job attempts by stage and outcome (succeeded, retry, failed, poisoned, lost, superseded)',
  labelNames: ['stage', 'outcome'],
  registers: [registry],
})

export const jobDuration = new client.Histogram({
  name: 'docqa_job_duration_seconds',
  help: 'Pipeline stage duration',
  labelNames: ['stage'],
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30],
  registers: [registry],
})

export const embedCalls = new client.Counter({
  name: 'docqa_embedder_calls_total',
  help: 'Embedder batch calls by result (ok, rate_limited, retryable_error, error)',
  labelNames: ['result'],
  registers: [registry],
})

export const recheckDrops = new client.Counter({
  name: 'docqa_recheck_dropped_total',
  help: 'Retrieved candidates dropped by the source-of-truth re-check, by reason',
  labelNames: ['reason'],
  registers: [registry],
})

export const answerCache = new client.Counter({
  name: 'docqa_answer_cache_total',
  help: 'Answer cache lookups by result (hit, miss, rejected)',
  labelNames: ['result'],
  registers: [registry],
})

export const runsFinished = new client.Counter({
  name: 'docqa_answer_runs_total',
  help: 'Answer runs by final status',
  labelNames: ['status'],
  registers: [registry],
})

export const ttftSeconds = new client.Histogram({
  name: 'docqa_answer_ttft_seconds',
  help: 'Time from run start to first output token',
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10],
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
