import { Router } from 'express'
import { pool } from '../../shared/db.js'
import { asyncHandler } from '../../shared/errors.js'
import { requireRole } from '../../shared/auth.js'
import { histogramPercentile, INF } from '../../projector/analytics.js'
import { COMMODITIES, EQUIPMENT, LANES, STATIONS, weekStart } from '../../shared/reference.js'

/** Reads the analytics projection (built by the projector from the event log, never from the quotes table). */
export function analyticsRouter(): Router {
  const router = Router()
  router.use(requireRole('ops'))

  router.get(
    '/',
    asyncHandler(async (_req, res) => {
      const hourly = await pool.query<{ bucket: Date; metric: string; dimension: string; value: number }>(
        `SELECT bucket, metric, dimension, value FROM analytics_counters WHERE bucket >= date_trunc('hour', now()) - interval '23 hours' ORDER BY bucket`,
      )
      const totals = await pool.query<{ metric: string; dimension: string; value: number }>(
        'SELECT metric, dimension, SUM(value)::bigint AS value FROM analytics_counters GROUP BY metric, dimension ORDER BY metric, dimension',
      )
      const latency = await pool.query<{ dependency: string; le_ms: number; count: number }>('SELECT dependency, le_ms, count FROM analytics_latency')
      const sources = await pool.query<{ dependency: string; source: string; count: number }>('SELECT dependency, source, count FROM analytics_sources ORDER BY dependency, source')
      const cp = await pool.query('SELECT * FROM projection_checkpoints WHERE projection = $1', ['analytics'])

      const byDep = new Map<string, { le: number; count: number }[]>()
      for (const r of latency.rows) {
        const list = byDep.get(r.dependency) ?? []
        list.push({ le: r.le_ms, count: Number(r.count) })
        byDep.set(r.dependency, list)
      }
      const fmt = (v: number | null) => (v === null ? null : v === INF ? 'inf' : v)
      const latencyOut = [...byDep.entries()].map(([dependency, buckets]) => ({
        dependency,
        count: buckets.reduce((s, b) => s + b.count, 0),
        p50: fmt(histogramPercentile(buckets, 50)),
        p95: fmt(histogramPercentile(buckets, 95)),
        p99: fmt(histogramPercentile(buckets, 99)),
        buckets: buckets.sort((a, b) => a.le - b.le),
      }))

      const total = (metric: string, dimension?: string) =>
        totals.rows.filter((r) => r.metric === metric && (!dimension || r.dimension === dimension)).reduce((s, r) => s + Number(r.value), 0)
      const firmIssued = total('issued', 'firm') + total('firm_completed')
      res.json({
        hourly: hourly.rows.map((r) => ({ bucket: new Date(r.bucket).toISOString(), metric: r.metric, dimension: r.dimension, value: Number(r.value) })),
        totals: totals.rows.map((r) => ({ ...r, value: Number(r.value) })),
        conversion: {
          requested: total('requested'),
          firmQuotes: firmIssued,
          booked: total('booked'),
          expired: total('expired'),
          rate: firmIssued > 0 ? total('booked') / firmIssued : null,
        },
        latency: latencyOut,
        sources: sources.rows.map((r) => ({ ...r, count: Number(r.count) })),
        checkpoint: cp.rows[0] ?? null,
      })
    }),
  )
  return router
}

export function referenceRouter(): Router {
  const router = Router()
  router.get('/', (_req, res) => {
    const now = new Date()
    const weeks = [0, 1, 2, 3].map((i) => weekStart(new Date(now.getTime() + (i + 1) * 7 * 86_400_000)))
    res.json({ stations: STATIONS, lanes: LANES, commodities: COMMODITIES, equipment: EQUIPMENT, shipWeeks: weeks })
  })
  return router
}
