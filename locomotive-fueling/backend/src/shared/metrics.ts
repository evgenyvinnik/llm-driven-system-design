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

export const telemetryIngested = new client.Counter({
  name: 'fueling_telemetry_ingested_total',
  help: 'Readings accepted at the ingest edge, by outcome (accepted, duplicate_batch)',
  labelNames: ['outcome'],
  registers: [registry],
})

export const telemetryProcessed = new client.Counter({
  name: 'fueling_telemetry_processed_total',
  help: 'Readings handled by the processor, by outcome (applied, late, duplicate)',
  labelNames: ['outcome'],
  registers: [registry],
})

export const processorLagSeconds = new client.Gauge({
  name: 'fueling_processor_event_lag_seconds',
  help: 'Simulated-time gap between the newest reading processed and the sim clock',
  registers: [registry],
})

export const alertsRaised = new client.Counter({
  name: 'fueling_alerts_raised_total',
  help: 'Alerts opened, by type',
  labelNames: ['type'],
  registers: [registry],
})

export const planRuns = new client.Histogram({
  name: 'fueling_planner_run_seconds',
  help: 'Planner run time (load inputs, optimize, persist), by decision',
  labelNames: ['decision'],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2],
  registers: [registry],
})

export const planTriggers = new client.Counter({
  name: 'fueling_plan_triggers_total',
  help: 'Re-plan triggers enqueued, by trigger and whether they were coalesced',
  labelNames: ['trigger', 'coalesced'],
  registers: [registry],
})

export const vendorCalls = new client.Histogram({
  name: 'fueling_vendor_call_seconds',
  help: 'DTL vendor API calls, by operation and outcome',
  labelNames: ['op', 'outcome'],
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 3, 5],
  registers: [registry],
})

export const orderTransitions = new client.Counter({
  name: 'fueling_order_transitions_total',
  help: 'DTL order status transitions',
  labelNames: ['to'],
  registers: [registry],
})

export const sseConnections = new client.Gauge({
  name: 'fueling_sse_connections',
  help: 'Open live-update streams on this API instance',
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
