/**
 * Prometheus metrics. Each API instance and the ingest worker expose their own registry on /metrics.
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

export const snapshotCompiles = new client.Histogram({
  name: 'exp_snapshot_compile_seconds',
  help: 'Time to compile and store a snapshot inside the write transaction',
  labelNames: ['environment'],
  buckets: [0.002, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25],
  registers: [registry],
})

export const snapshotVersion = new client.Gauge({
  name: 'exp_snapshot_version',
  help: 'Snapshot version this instance holds in memory, per environment',
  labelNames: ['environment'],
  registers: [registry],
})

export const snapshotRequests = new client.Counter({
  name: 'exp_snapshot_requests_total',
  help: 'SDK snapshot fetches by result (200, 304, by_version)',
  labelNames: ['environment', 'result'],
  registers: [registry],
})

export const snapshotReloads = new client.Counter({
  name: 'exp_snapshot_reloads_total',
  help: 'In-memory snapshot reloads by trigger (pubsub, reconcile, cold, by_version)',
  labelNames: ['trigger'],
  registers: [registry],
})

export const streamConnections = new client.Gauge({
  name: 'exp_sse_connections',
  help: 'Open SDK SSE streams on this instance',
  registers: [registry],
})

export const pushesSent = new client.Counter({
  name: 'exp_snapshot_pushes_total',
  help: 'Snapshot version events written to SDK streams on this instance',
  registers: [registry],
})

export const propagationSeconds = new client.Histogram({
  name: 'exp_snapshot_propagation_seconds',
  help: 'Publish of a snapshot version → an SDK client reporting it holds that version',
  labelNames: ['environment', 'reason'],
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 30],
  registers: [registry],
})

export const ingestEvents = new client.Counter({
  name: 'exp_ingest_events_total',
  help: 'Events received by the ingest endpoint, by type and outcome (accepted, duplicate_batch, rejected)',
  labelNames: ['type', 'outcome'],
  registers: [registry],
})

export const workerRows = new client.Counter({
  name: 'exp_worker_rows_total',
  help: 'Rows inserted into ClickHouse by the ingest worker, per table',
  labelNames: ['table'],
  registers: [registry],
})

export const workerInsertSeconds = new client.Histogram({
  name: 'exp_worker_insert_seconds',
  help: 'ClickHouse insert duration per worker batch',
  buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  registers: [registry],
})

export const workerLag = new client.Gauge({
  name: 'exp_worker_stream_lag_entries',
  help: 'Entries in the event stream not yet acknowledged by the worker group',
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
