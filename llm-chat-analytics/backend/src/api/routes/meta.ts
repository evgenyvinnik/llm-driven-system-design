/**
 * Catalog, freshness and pipeline health.
 *
 * GET /meta       metric definitions, the event contract, dimensions and coverage
 * GET /freshness  per-stream watermarks and recent revisions for one org
 * GET /pipeline   ingest health across all orgs: positions, counters, rejections
 */
import { Router } from 'express'
import { requireAuth, requireOrgAccess } from '../../shared/auth.js'
import { keys, redis } from '../../shared/cache.js'
import { chQuery } from '../../shared/clickhouse.js'
import { config } from '../../shared/config.js'
import { chatEventSchema, CONTENT_KEYS, EVENT_TYPES, FEATURES } from '../../shared/contract.js'
import { pool } from '../../shared/db.js'
import { asyncHandler, HttpError } from '../../shared/errors.js'
import { localDate } from '../../shared/time.js'
import type { PartitionPosition } from '../../shared/watermark.js'
import { METRICS } from '../services/catalog.js'
import { getCoverage, metricInfo, readWatermarks } from '../services/query-service.js'

export const metaRouter = Router()
metaRouter.use(requireAuth)

const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString())

metaRouter.get(
  '/meta',
  asyncHandler(async (_req, res) => {
    const coverage = await getCoverage()
    const { rows } = await pool.query<{ model: string }>('SELECT DISTINCT model FROM model_prices ORDER BY model')
    const shape = chatEventSchema._def.schema.shape
    res.json({
      metrics: METRICS.map((m) => {
        const cov = coverage.get(m.id)
        return { ...metricInfo(m), coverage: cov ? { collectedFrom: iso(cov.collectedFrom), availableFrom: iso(cov.availableFrom), note: cov.note } : null }
      }),
      dimensions: { model: rows.map((r) => r.model), feature: FEATURES },
      eventTypes: EVENT_TYPES,
      eventContract: Object.entries(shape).map(([field, schema]) => ({ field, optional: schema.isOptional() })),
      forbiddenKeys: CONTENT_KEYS,
      minCohortUsers: config.minCohortUsers,
      latenessAllowanceMs: config.latenessAllowanceMs,
      maxLatenessHours: config.maxLatenessMs / 3_600_000,
    })
  }),
)

metaRouter.get(
  '/freshness',
  asyncHandler(async (req, res) => {
    const org = typeof req.query.org === 'string' ? req.query.org : ''
    if (!org) throw new HttpError(400, 'MISSING_ORG', 'org is required')
    const access = await requireOrgAccess(req.user!, org)
    const now = Date.now()
    const report = await readWatermarks(now)
    const today = localDate(now, access.timeZone)
    const revisions = await chQuery<{ day: string; events: number; late_events: number; last_revised_at: string }>(
      `SELECT toString(local_date) AS day,
              sum(conversations) + sum(messages) + sum(responses_ok) + sum(responses_failed) + sum(responses_abandoned) AS events,
              sum(late_events) AS late_events, toString(max(last_revised_at)) AS last_revised_at
         FROM rollup_day_local
        WHERE org_id = {org:String} AND local_date >= toDate({today:String}) - 3
        GROUP BY day ORDER BY day DESC`,
      { org, today },
    )
    res.json({
      now: iso(now),
      timeZone: access.timeZone,
      processedThrough: iso(report.processedThrough),
      watermarks: { client: iso(report.watermarks.client), server: iso(report.watermarks.server) },
      allowanceMs: config.latenessAllowanceMs,
      maxLatenessHours: config.maxLatenessMs / 3_600_000,
      backlog: report.totalLag,
      stalledPartitions: report.stalled,
      missingPartitions: report.missing,
      days: revisions.map((r) => ({
        localDate: r.day,
        events: Number(r.events),
        lateEvents: Number(r.late_events),
        lastRevisedAt: r.last_revised_at.startsWith('1970') ? null : `${r.last_revised_at.replace(' ', 'T')}Z`,
      })),
    })
  }),
)

metaRouter.get(
  '/pipeline',
  asyncHandler(async (_req, res) => {
    const now = Date.now()
    const [report, counters, positionsRaw] = await Promise.all([
      readWatermarks(now),
      redis.hgetall(keys.counters),
      redis.hgetall(keys.positions) as Promise<Record<string, string>>,
    ])
    const [rejected, perMinute] = await Promise.all([
      chQuery<{ reason: string; n: number; last_at: string; detail: string }>(
        `SELECT reason, count() AS n, toString(max(rejected_at)) AS last_at, any(detail) AS detail
           FROM rejected_events WHERE rejected_at > now() - INTERVAL 1 DAY GROUP BY reason ORDER BY n DESC`,
      ),
      chQuery<{ minute: string; rows: number; late: number }>(
        `SELECT toString(toStartOfMinute(ingested_at)) AS minute, count() AS rows, countIf(is_late = 1) AS late
           FROM events WHERE ingested_at > now() - INTERVAL 30 MINUTE GROUP BY minute ORDER BY minute`,
      ),
    ])
    res.json({
      now: iso(now),
      partitions: Object.entries(positionsRaw)
        .map(([p, v]) => {
          const pos = JSON.parse(v) as PartitionPosition
          return { partition: Number(p), position: iso(pos.position), updatedAt: iso(pos.updatedAt), lag: pos.lag ?? 0, stalled: report.stalled.includes(Number(p)) }
        })
        .sort((a, b) => a.partition - b.partition),
      processedThrough: iso(report.processedThrough),
      watermarks: { client: iso(report.watermarks.client), server: iso(report.watermarks.server) },
      missingPartitions: report.missing,
      counters: Object.fromEntries(Object.entries(counters).map(([k, v]) => [k, Number(v)])),
      rejected: rejected.map((r) => ({ reason: r.reason, count: Number(r.n), lastAt: `${r.last_at.replace(' ', 'T')}Z`, sampleDetail: r.detail })),
      ingestedPerMinute: perMinute.map((m) => ({ minute: `${m.minute.replace(' ', 'T')}Z`, rows: Number(m.rows), late: Number(m.late) })),
    })
  }),
)
