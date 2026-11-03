/**
 * Prometheus metrics, exposed on /metrics.
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

/** Every refused write, by reason. A rising OVER_CAPACITY rate is a product signal, not an outage. */
export const writesRefused = new client.Counter({
  name: 'fs_writes_refused_total',
  help: 'Writes refused by a namespace or quota rule',
  labelNames: ['code'],
  registers: [registry],
})

/** Transactions retried after PostgreSQL aborted them for a deadlock or serialization failure. */
export const txRetries = new client.Counter({
  name: 'fs_transaction_retries_total',
  help: 'Transactions retried after a deadlock or serialization failure',
  labelNames: ['operation'],
  registers: [registry],
})

export const restoreSkipped = new client.Counter({
  name: 'fs_restore_skipped_paths_total',
  help: 'Backed-up paths a restore skipped because another owner now holds them',
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
