/**
 * Prometheus metrics. The API and the analyzer each expose their own registry
 * on /metrics (the analyzer on ANALYZER_PORT).
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

export const passesIngested = new client.Counter({
  name: 'rh_passes_ingested_total',
  help: 'Detector passes received by the ingest endpoint, by outcome (accepted, duplicate)',
  labelNames: ['outcome'],
  registers: [registry],
})

export const ingestLagMinutes = new client.Histogram({
  name: 'rh_ingest_lag_minutes',
  help: 'Domain-time delay between a train passing a detector and the pass reaching the API',
  buckets: [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 240, 480],
  registers: [registry],
})

export const passesProcessed = new client.Counter({
  name: 'rh_passes_processed_total',
  help: 'Passes handled by the analyzer, by outcome (processed, already_processed, awaiting_consist, unresolved, failed) and lane',
  labelNames: ['outcome', 'lane'],
  registers: [registry],
})

export const processSeconds = new client.Histogram({
  name: 'rh_pass_process_seconds',
  help: 'Analyzer time to resolve, trend and score one pass, by lane',
  labelNames: ['lane'],
  buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5],
  registers: [registry],
})

export const alertTransitions = new client.Counter({
  name: 'rh_alert_transitions_total',
  help: 'Alerts opened or escalated, by tier and lateness',
  labelNames: ['transition', 'tier', 'late'],
  registers: [registry],
})

export const ackEscalations = new client.Counter({
  name: 'rh_ack_escalations_total',
  help: 'Alerts escalated to the next role, by reason (ack_overdue, approaching_yard)',
  labelNames: ['reason'],
  registers: [registry],
})

export const streamRedeliveries = new client.Counter({
  name: 'rh_stream_redeliveries_total',
  help: 'Stream messages claimed from a stalled consumer or dead-lettered',
  labelNames: ['kind'],
  registers: [registry],
})

export const sseConnections = new client.Gauge({
  name: 'rh_sse_connections',
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
