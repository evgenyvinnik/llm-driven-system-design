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

export const permissionCacheResults = new client.Counter({
  name: 'console_permission_cache_total',
  help: 'Effective-access lookups by outcome (hit, miss, authoritative)',
  labelNames: ['result'],
  registers: [registry],
})

export const authzDenials = new client.Counter({
  name: 'console_authz_denials_total',
  help: 'Requests refused by the org access check, by status and code',
  labelNames: ['status', 'code'],
  registers: [registry],
})

export const sseConnections = new client.Gauge({
  name: 'console_sse_connections',
  help: 'Open event streams on this API instance',
  registers: [registry],
})

export const exportsFinished = new client.Counter({
  name: 'console_exports_finished_total',
  help: 'Export jobs reaching a terminal state',
  labelNames: ['status'],
  registers: [registry],
})

export function httpMetrics(req: Request, res: Response, next: NextFunction): void {
  const end = httpDuration.startTimer()
  res.on('close', () => {
    // Route patterns, not raw paths, keep label cardinality bounded. baseUrl is
    // already resolved, so the org segment is put back as a pattern.
    const base = req.baseUrl.replace(/\/orgs\/[^/]+/, '/orgs/:orgId')
    const route = req.route?.path ? `${base}${req.route.path}` : 'unmatched'
    end({ method: req.method, route, status: String(res.statusCode) })
  })
  next()
}

export async function metricsHandler(_req: Request, res: Response): Promise<void> {
  res.set('Content-Type', registry.contentType)
  res.end(await registry.metrics())
}
