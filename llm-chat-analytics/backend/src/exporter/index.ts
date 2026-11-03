/**
 * Export worker. Claims queued jobs from PostgreSQL with FOR UPDATE SKIP
 * LOCKED and a lease, writes the CSV one org-local day at a time, and reports
 * progress after each page. Every progress write is fenced on worker_id, so a
 * worker whose lease was taken over stops instead of racing the new owner.
 */
import { createWriteStream, existsSync, mkdirSync, renameSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import express from 'express'
import { listAccess, type SessionUser } from '../shared/auth.js'
import { redis } from '../shared/cache.js'
import { chQuery, clickhouse } from '../shared/clickhouse.js'
import { config } from '../shared/config.js'
import { pool } from '../shared/db.js'
import { childLogger } from '../shared/logger.js'
import { exportJobs, metricsHandler } from '../shared/metrics.js'
import { bucketsFor } from '../shared/time.js'
import { METRIC_BY_ID } from '../api/services/catalog.js'
import { coverageState, getCoverage } from '../api/services/query-service.js'
import { parseFilters, type Filters } from '../api/services/query-spec.js'
import { filterClause, MERGED, toAggregates, type AggregateRow } from '../api/services/sql.js'

const log = childLogger('exporter')
const workerId = `exporter-${process.pid}`

interface Job {
  id: string
  user_id: string
  org_id: string
  kind: 'daily_metrics' | 'conversations'
  query: Record<string, string>
  columns: string[]
}

class LeaseLost extends Error {}

function csvCell(v: unknown): string {
  if (v === null || v === undefined) return ''
  const s = Array.isArray(v) ? v.join('|') : String(v)
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

async function claim(): Promise<Job | null> {
  const { rows } = await pool.query<Job>(
    `UPDATE export_jobs SET status = 'running', worker_id = $1, attempts = attempts + 1,
            started_at = COALESCE(started_at, now()), lease_expires_at = now() + make_interval(secs => $2)
      WHERE id = (SELECT id FROM export_jobs
                   WHERE status = 'queued' OR (status = 'running' AND lease_expires_at < now())
                   ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1)
      RETURNING id, user_id, org_id, kind, query, columns`,
    [workerId, config.exportLeaseSeconds],
  )
  return rows[0] ?? null
}

async function progress(jobId: string, done: number, total?: number): Promise<void> {
  const { rowCount } = await pool.query(
    `UPDATE export_jobs SET rows_done = $3, rows_total = COALESCE($4, rows_total), lease_expires_at = now() + make_interval(secs => $5)
      WHERE id = $1 AND worker_id = $2 AND status = 'running'`,
    [jobId, workerId, done, total ?? null, config.exportLeaseSeconds],
  )
  if (!rowCount) throw new LeaseLost(`lost the lease on ${jobId}`)
}

async function runJob(job: Job): Promise<void> {
  const { rows: users } = await pool.query<{ id: string; username: string; display_name: string; is_staff: boolean }>(
    'SELECT id, username, display_name, is_staff FROM users WHERE id = $1',
    [job.user_id],
  )
  const user: SessionUser = { id: String(users[0].id), username: users[0].username, displayName: users[0].display_name, isStaff: users[0].is_staff }
  const access = (await listAccess(user)).find((a) => a.orgId === job.org_id)
  if (!access) throw new Error('The requester no longer has access to this org')
  const filters = parseFilters(job.query, access.timeZone)
  const days = bucketsFor(filters.from, Math.min(filters.to, Date.now() + 86_400_000), 'day', access.timeZone)

  mkdirSync(config.exportDir, { recursive: true })
  const finalPath = join(config.exportDir, `${job.id}.csv`)
  const partial = `${finalPath}.partial`
  const out = createWriteStream(partial)
  const write = (line: string) => new Promise<void>((resolve, reject) => out.write(line, (err) => (err ? reject(err) : resolve())))
  await write(`${job.columns.join(',')}\n`)

  const writer = job.kind === 'daily_metrics' ? dailyRows : conversationRows
  let done = 0
  await progress(job.id, 0, days.length)
  for (const day of days) {
    const rows = await writer(filters, day.key, access.timeZone)
    for (const row of rows) await write(`${job.columns.map((c) => csvCell(row[c])).join(',')}\n`)
    done++
    await progress(job.id, done)
    if (config.exportPageDelayMs > 0) await new Promise((r) => setTimeout(r, config.exportPageDelayMs))
  }
  await new Promise<void>((resolve) => out.end(resolve))
  renameSync(partial, finalPath)
  const { rowCount } = await pool.query(
    `UPDATE export_jobs SET status = 'succeeded', file_path = $3, file_bytes = $4, finished_at = now(),
            expires_at = now() + make_interval(hours => $5), lease_expires_at = NULL
      WHERE id = $1 AND worker_id = $2 AND status = 'running'`,
    [job.id, workerId, finalPath, statSync(finalPath).size, config.exportTtlHours],
  )
  if (!rowCount) throw new LeaseLost(`lost the lease on ${job.id} before finishing`)
}

/** One row per (day, model, feature), with the same suppression rule as the breakdown charts. */
async function dailyRows(f: Filters, day: string, _timeZone: string): Promise<Record<string, unknown>[]> {
  const params: Record<string, unknown> = { day }
  const where = filterClause({ org: f.org, models: f.models, features: f.features }, params)
  const rows = await chQuery<AggregateRow>(
    `SELECT model, feature, ${MERGED} FROM rollup_day_local WHERE ${where} AND local_date = {day:Date} GROUP BY model, feature ORDER BY model, feature`,
    params,
  )
  const coverage = await getCoverage()
  const dayStart = Date.parse(`${day}T00:00:00Z`)
  const value = (id: string, a: ReturnType<typeof toAggregates>) => {
    const m = METRIC_BY_ID.get(id)!
    if (coverageState(coverage.get(id), dayStart) !== 'ok') return null
    const v = m.value(a)
    return v === null ? null : m.unit === 'percent' ? Number(v.toFixed(4)) : m.unit === 'usd' ? Number(v.toFixed(4)) : Math.round(v)
  }
  return rows.map((r) => {
    const a = toAggregates(r)
    const suppressed = a.active_users < config.minCohortUsers
    const base = { local_date: day, model: r.model, feature: r.feature, suppressed }
    if (suppressed) return base
    return {
      ...base,
      active_users: a.active_users,
      conversations: a.conversations,
      messages: a.messages,
      success_rate: value('success_rate', a),
      error_rate: value('error_rate', a),
      abandon_rate: value('abandon_rate', a),
      ttft_p50_ms: value('ttft_p50', a),
      ttft_p95_ms: value('ttft_p95', a),
      latency_p95_ms: value('latency_p95', a),
      total_tokens: value('total_tokens', a),
      late_events: a.late_events,
      cost_usd: value('cost_usd', a),
      cost_per_conversation: value('cost_per_conversation', a),
    }
  })
}

/** Conversation metadata for conversations started on one local day. Never content: the events carry none. */
async function conversationRows(f: Filters, day: string, timeZone: string): Promise<Record<string, unknown>[]> {
  const params: Record<string, unknown> = { day }
  const where = filterClause({ org: f.org, models: f.models, features: f.features }, params)
  const rows = await chQuery<Record<string, string | number>>(
    `SELECT conversation_id, any(user_id) AS user_id, toUnixTimestamp64Milli(min(event_time)) AS started_ms,
            any(model) AS model, arrayStringConcat(arraySort(groupUniqArray(feature)), '|') AS features,
            anyIf(platform, platform != '') AS platform,
            countIf(event_type = 'message_sent') AS messages,
            countIf(event_type = 'response_completed') AS responses_completed,
            countIf(event_type = 'response_failed') AS responses_failed,
            countIf(event_type = 'response_abandoned') AS responses_abandoned,
            sum(input_tokens + output_tokens) AS total_tokens, max(ttft_ms) AS max_ttft_ms,
            sum(cost_micros) AS cost_micros, max(is_late) AS had_late_events
       FROM events FINAL
      WHERE ${where} AND conversation_id IN (
              SELECT conversation_id FROM events
               WHERE ${where} AND local_date = {day:Date} AND event_type = 'conversation_started')
      GROUP BY conversation_id ORDER BY started_ms`,
    params,
  )
  return rows.map((r) => ({
    ...r,
    started_at_local: new Date(Number(r.started_ms)).toLocaleString('sv-SE', { timeZone }),
    had_late_events: Number(r.had_late_events) === 1,
    cost_usd: (Number(r.cost_micros) / 1_000_000).toFixed(6),
  }))
}

async function fail(job: Job, err: Error): Promise<void> {
  const { rows } = await pool.query<{ attempts: number }>('SELECT attempts FROM export_jobs WHERE id = $1', [job.id])
  const retry = (rows[0]?.attempts ?? 3) < 3 && !(err.message.includes('no longer has access'))
  await pool.query(
    `UPDATE export_jobs SET status = $3, error = $4, worker_id = NULL, lease_expires_at = NULL,
            finished_at = CASE WHEN $3 = 'failed' THEN now() ELSE NULL END
      WHERE id = $1 AND worker_id = $2`,
    [job.id, workerId, retry ? 'queued' : 'failed', err.message],
  )
  if (!retry) exportJobs.inc({ status: 'failed' })
}

async function expireOld(): Promise<void> {
  const { rows } = await pool.query<{ id: string; file_path: string | null }>(
    `UPDATE export_jobs SET status = 'expired' WHERE status = 'succeeded' AND expires_at < now() RETURNING id, file_path`,
  )
  for (const r of rows) if (r.file_path && existsSync(r.file_path)) unlinkSync(r.file_path)
}

async function loop(): Promise<void> {
  for (;;) {
    let job: Job | null = null
    try {
      await expireOld()
      job = await claim()
      if (!job) {
        await new Promise((r) => setTimeout(r, 1000))
        continue
      }
      log.info({ job: job.id, kind: job.kind, org: job.org_id }, 'export started')
      await runJob(job)
      exportJobs.inc({ status: 'succeeded' })
      log.info({ job: job.id }, 'export finished')
    } catch (err) {
      if (err instanceof LeaseLost) {
        log.warn({ job: job?.id }, err.message)
      } else if (job) {
        log.error({ job: job.id, err: (err as Error).message }, 'export failed')
        await fail(job, err as Error).catch(() => undefined)
      } else {
        log.warn({ err: (err as Error).message }, 'export loop error')
        await new Promise((r) => setTimeout(r, 2000))
      }
    }
  }
}

const app = express()
app.get('/health', (_req, res) => res.json({ status: 'ok', workerId }))
app.get('/metrics', metricsHandler)
app.listen(config.exporterPort, () => log.info({ port: config.exporterPort }, 'exporter listening'))

const shutdown = async () => {
  await Promise.allSettled([pool.end(), redis.quit(), clickhouse.close()])
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

loop()
