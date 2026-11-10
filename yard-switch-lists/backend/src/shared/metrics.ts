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

export const solvesTotal = new client.Counter({
  name: 'yard_solves_total',
  help: 'Planner solves by algorithm, purpose and how they ended',
  labelNames: ['algorithm', 'purpose', 'terminated_by'],
  registers: [registry],
})

export const solveSeconds = new client.Histogram({
  name: 'yard_solve_seconds',
  help: 'Wall time of a planner solve',
  labelNames: ['algorithm'],
  buckets: [0.05, 0.1, 0.5, 1, 2.5, 5, 10, 30, 60],
  registers: [registry],
})

export const solveLeaseReclaims = new client.Counter({
  name: 'yard_solve_lease_reclaims_total',
  help: 'Solves taken over after a worker lost its lease',
  registers: [registry],
})

export const triggersCoalesced = new client.Histogram({
  name: 'yard_replan_triggers_per_solve',
  help: 'How many replan triggers one solve absorbed',
  buckets: [1, 2, 3, 5, 8, 13, 21],
  registers: [registry],
})

export const publishOutcomes = new client.Counter({
  name: 'yard_publish_total',
  help: 'Publish attempts by outcome (published, stale_state, head_moved, validation_failed, conflict)',
  labelNames: ['outcome'],
  registers: [registry],
})

export const validatorRuns = new client.Counter({
  name: 'yard_validator_runs_total',
  help: 'Validator runs by plan author and result',
  labelNames: ['author', 'result'],
  registers: [registry],
})

export const crewReports = new client.Counter({
  name: 'yard_crew_reports_total',
  help: 'Crew reports by kind and outcome (applied, duplicate, late, refused)',
  labelNames: ['kind', 'outcome'],
  registers: [registry],
})

export const holdEvents = new client.Counter({
  name: 'yard_hold_events_total',
  help: 'Hold feed events by outcome (applied, duplicate, stale, other_yard, rejected)',
  labelNames: ['type', 'outcome'],
  registers: [registry],
})

export const overridesTotal = new client.Counter({
  name: 'yard_overrides_total',
  help: 'Yardmaster overrides by kind',
  labelNames: ['kind'],
  registers: [registry],
})

const ROUTE_NORMALIZER = /\/[0-9a-f]{8}-[0-9a-f-]{27,}|\/\d+/g

export function httpMetrics(req: Request, res: Response, next: NextFunction): void {
  const stop = httpDuration.startTimer()
  res.on('finish', () => {
    stop({ method: req.method, route: req.path.replace(ROUTE_NORMALIZER, '/:id'), status: String(res.statusCode) })
  })
  next()
}

export async function metricsHandler(_req: Request, res: Response): Promise<void> {
  res.set('Content-Type', registry.contentType)
  res.end(await registry.metrics())
}
