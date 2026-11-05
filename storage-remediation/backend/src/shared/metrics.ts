/**
 * Prometheus metrics. Each process exposes its own registry on /metrics; the
 * metric names below are shared so dashboards work across instances.
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

export const armRequests = new client.Counter({
  name: 'remediation_arm_requests_total',
  help: 'Control-plane requests by operation and HTTP status',
  labelNames: ['op', 'status'],
  registers: [registry],
})

export const armThrottled = new client.Counter({
  name: 'remediation_arm_throttled_total',
  help: '429 responses received, by operation',
  labelNames: ['op'],
  registers: [registry],
})

export const scanDuration = new client.Histogram({
  name: 'remediation_scan_seconds',
  help: 'Scanner pass duration by kind',
  labelNames: ['kind'],
  buckets: [0.1, 0.5, 1, 2, 5, 10, 30, 60, 120, 300],
  registers: [registry],
})

export const changeEventsProcessed = new client.Counter({
  name: 'remediation_change_events_total',
  help: 'Change-feed events processed by the scanner',
  labelNames: ['outcome'],
  registers: [registry],
})

export const findingsGauge = new client.Gauge({
  name: 'remediation_open_findings',
  help: 'Open findings by control',
  labelNames: ['control'],
  registers: [registry],
})

export const targetTransitions = new client.Counter({
  name: 'remediation_target_transitions_total',
  help: 'Campaign target state transitions',
  labelNames: ['to'],
  registers: [registry],
})

export const applyDuration = new client.Histogram({
  name: 'remediation_apply_seconds',
  help: 'Time from claim to applied (includes token waits and retries)',
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 30],
  registers: [registry],
})

export const rollbacks = new client.Counter({
  name: 'remediation_rollbacks_total',
  help: 'Automatic rollbacks by control and outcome',
  labelNames: ['control', 'outcome'],
  registers: [registry],
})

export const tokenWaitSeconds = new client.Histogram({
  name: 'remediation_token_wait_seconds',
  help: 'Time spent waiting for a per-subscription write token',
  buckets: [0, 0.1, 0.25, 0.5, 1, 2, 5, 10],
  registers: [registry],
})

export const sseConnections = new client.Gauge({
  name: 'remediation_sse_connections',
  help: 'Open campaign event streams on this API instance',
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
