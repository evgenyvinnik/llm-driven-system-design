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

export const webhookOutcomes = new client.Counter({
  name: 'cicd_webhooks_total',
  help: 'Webhook deliveries by outcome (created_run, duplicate, bad_signature, no_workflow, filtered, unknown_commit, invalid_workflow)',
  labelNames: ['outcome'],
  registers: [registry],
})

export const claims = new client.Counter({
  name: 'cicd_claims_total',
  help: 'Job claims by outcome (claimed, empty, gate_denied)',
  labelNames: ['outcome'],
  registers: [registry],
})

export const queueWait = new client.Histogram({
  name: 'cicd_queue_wait_seconds',
  help: 'Time from a job becoming ready to being claimed',
  buckets: [0.1, 0.5, 1, 2, 5, 10, 30, 60, 120, 300],
  registers: [registry],
})

export const jobOutcomes = new client.Counter({
  name: 'cicd_job_attempts_total',
  help: 'Finished job attempts by outcome',
  labelNames: ['outcome'],
  registers: [registry],
})

export const leaseDecisions = new client.Counter({
  name: 'cicd_lease_expiries_total',
  help: 'Lease expiries by decision (requeue, needs_attention, fail)',
  labelNames: ['decision'],
  registers: [registry],
})

export const staleWrites = new client.Counter({
  name: 'cicd_stale_writes_rejected_total',
  help: 'Runner writes rejected by the fencing token',
  labelNames: ['operation'],
  registers: [registry],
})

export const secretReleases = new client.Counter({
  name: 'cicd_secret_releases_total',
  help: 'Secrets released to a job attempt at claim time',
  registers: [registry],
})

export const secretsWithheld = new client.Counter({
  name: 'cicd_secrets_withheld_total',
  help: 'Requested secrets a job did not receive, by reason',
  labelNames: ['reason'],
  registers: [registry],
})

export const logChunks = new client.Counter({
  name: 'cicd_log_chunks_total',
  help: 'Log chunks received by outcome (assembled, buffered, duplicate, rejected)',
  labelNames: ['outcome'],
  registers: [registry],
})

export const sseConnections = new client.Gauge({
  name: 'cicd_log_stream_connections',
  help: 'Open log SSE connections on this instance',
  registers: [registry],
})

export const queueDepth = new client.Gauge({
  name: 'cicd_queue_depth',
  help: 'Queued jobs per runner label',
  labelNames: ['label'],
  registers: [registry],
})

export function httpMetrics(req: Request, res: Response, next: NextFunction): void {
  const end = httpDuration.startTimer()
  res.on('finish', () => {
    // A route pattern, never the raw path: ids would explode the label cardinality.
    const route = (req.route?.path as string | undefined) ?? 'unmatched'
    end({ method: req.method, route: `${req.baseUrl}${route}`, status: String(res.statusCode) })
  })
  next()
}

export async function metricsHandler(_req: Request, res: Response): Promise<void> {
  res.setHeader('Content-Type', registry.contentType)
  res.end(await registry.metrics())
}
