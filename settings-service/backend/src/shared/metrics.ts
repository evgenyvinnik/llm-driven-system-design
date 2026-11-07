/**
 * Prometheus metrics. Each API instance exposes its own registry on /metrics.
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

export const patchOutcomes = new client.Counter({
  name: 'settings_patch_total',
  help: 'User PATCH outcomes: applied, noop, conflict, invalid, locked, precondition',
  labelNames: ['outcome'],
  registers: [registry],
})

export const patchKeys = new client.Counter({
  name: 'settings_patch_keys_total',
  help: 'Keys in user PATCHes by result: changed, unchanged, deprecated_ignored',
  labelNames: ['result'],
  registers: [registry],
})

export const policyChanges = new client.Counter({
  name: 'settings_policy_changes_total',
  help: 'Org policy writes by outcome',
  labelNames: ['outcome'],
  registers: [registry],
})

export const eventsPublished = new client.Counter({
  name: 'settings_events_published_total',
  help: 'Change notifications published to Valkey, by type and result',
  labelNames: ['type', 'result'],
  registers: [registry],
})

export const eventsDelivered = new client.Counter({
  name: 'settings_events_delivered_total',
  help: 'Change notifications written to SSE streams on this instance, by type',
  labelNames: ['type'],
  registers: [registry],
})

export const sseConnections = new client.Gauge({
  name: 'settings_sse_connections',
  help: 'Open SSE streams on this instance',
  registers: [registry],
})

export const catalogReloads = new client.Counter({
  name: 'settings_catalog_reloads_total',
  help: 'In-memory catalog reloads, by reason (cold, ttl, invalidated, unknown_key)',
  labelNames: ['reason'],
  registers: [registry],
})

export const chaosDropped = new client.Counter({
  name: 'settings_chaos_dropped_responses_total',
  help: 'PATCH responses deliberately dropped after commit by the chaos switch',
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
