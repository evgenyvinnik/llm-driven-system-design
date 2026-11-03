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
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  registers: [registry],
})

export const eventsIngested = new client.Counter({
  name: 'analytics_events_ingested_total',
  help: 'Events written to ClickHouse',
  labelNames: ['stream', 'late'],
  registers: [registry],
})

export const eventsDropped = new client.Counter({
  name: 'analytics_events_dropped_total',
  help: 'Events not written: duplicate, already inserted, or rejected with a reason',
  labelNames: ['reason'],
  registers: [registry],
})

export const ingestBatchSeconds = new client.Histogram({
  name: 'analytics_ingest_batch_seconds',
  help: 'Time to dedup, insert and commit one batch',
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 5],
  registers: [registry],
})

export const watermarkLagSeconds = new client.Gauge({
  name: 'analytics_watermark_lag_seconds',
  help: 'now minus the complete-through watermark, per stream',
  labelNames: ['stream'],
  registers: [registry],
})

export const queryCache = new client.Counter({
  name: 'analytics_query_cache_total',
  help: 'Query cache lookups',
  labelNames: ['widget', 'result'],
  registers: [registry],
})

export const queryDuration = new client.Histogram({
  name: 'analytics_query_seconds',
  help: 'ClickHouse time per dashboard widget query (cache misses only)',
  labelNames: ['widget'],
  buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 5],
  registers: [registry],
})

export const exportJobs = new client.Counter({
  name: 'analytics_export_jobs_total',
  help: 'Export jobs finished',
  labelNames: ['status'],
  registers: [registry],
})

export function httpMetrics(req: Request, res: Response, next: NextFunction): void {
  const end = httpDuration.startTimer()
  res.on('finish', () => {
    const route = req.route?.path ? `${req.baseUrl}${req.route.path}` : 'unmatched'
    end({ method: req.method, route, status: String(res.statusCode) })
  })
  next()
}

export async function metricsHandler(_req: Request, res: Response): Promise<void> {
  res.set('Content-Type', registry.contentType)
  res.end(await registry.metrics())
}
