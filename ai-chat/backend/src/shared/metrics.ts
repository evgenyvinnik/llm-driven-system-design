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

export const generationsCreated = new client.Counter({
  name: 'chat_generations_created_total',
  help: 'Generations accepted by the API, by kind (message, edit, regenerate)',
  labelNames: ['model', 'kind'],
  registers: [registry],
})

export const idempotentReplays = new client.Counter({
  name: 'chat_idempotent_replays_total',
  help: 'POSTs answered with an existing generation because the Idempotency-Key was seen before',
  registers: [registry],
})

export const generationsFinished = new client.Counter({
  name: 'chat_generations_finished_total',
  help: 'Generations reaching a terminal state',
  labelNames: ['model', 'status'],
  registers: [registry],
})

export const generationQueueSeconds = new client.Histogram({
  name: 'chat_generation_queue_seconds',
  help: 'Time from acceptance to an executor claiming the generation',
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 30],
  registers: [registry],
})

export const generationTtftSeconds = new client.Histogram({
  name: 'chat_generation_ttft_seconds',
  help: 'Time from claim to first output token',
  labelNames: ['model'],
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 5],
  registers: [registry],
})

export const generationsInFlight = new client.Gauge({
  name: 'chat_generations_in_flight',
  help: 'Generations currently executing in this executor',
  registers: [registry],
})

export const checkpointsWritten = new client.Counter({
  name: 'chat_checkpoints_written_total',
  help: 'Partial-output checkpoints written to PostgreSQL',
  registers: [registry],
})

export const sseConnections = new client.Gauge({
  name: 'chat_sse_connections',
  help: 'Open SSE streams on this API instance',
  labelNames: ['kind'],
  registers: [registry],
})

export const streamResumes = new client.Counter({
  name: 'chat_stream_resumes_total',
  help: 'Generation streams opened with a Last-Event-ID (a reconnect or a refresh)',
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
