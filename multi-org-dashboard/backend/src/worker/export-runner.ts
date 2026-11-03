/**
 * Runs one export job. The job row in PostgreSQL is the queue: a worker
 * claims it with FOR UPDATE SKIP LOCKED and a lease, renews the lease with
 * every batch, and every write is fenced on (worker_id, status = 'running'),
 * so a worker whose lease expired can't overwrite the worker that took over.
 *
 * Access is checked against PostgreSQL (never the cache) when the job starts
 * and again right before the file is published. An export started by
 * someone who has since lost access never produces a file.
 */
import { createWriteStream } from 'node:fs'
import { mkdir, rename, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { once } from 'node:events'
import { computeFromDatabase, type EffectiveAccess } from '../shared/access.js'
import { config } from '../shared/config.js'
import {
  buildConversationWhere,
  CONVERSATION_COLUMNS,
  CONVERSATION_FROM,
  conversationFiltersSchema,
  type Cursor,
} from '../shared/conversation-query.js'
import { pool } from '../shared/db.js'
import { publishUserEvent } from '../shared/events.js'
import { logger } from '../shared/logger.js'
import { exportsFinished } from '../shared/metrics.js'

export interface ClaimedJob {
  id: string
  org_id: string
  created_by: string
  query: unknown
  attempts: number
}

class Fenced extends Error {}
class Cancelled extends Error {}
class AccessLost extends Error {}

/** Claims the oldest runnable job: queued, or running with an expired lease (its worker died). */
export async function claimJob(workerId: string): Promise<ClaimedJob | null> {
  const { rows } = await pool.query(
    `UPDATE export_jobs SET status = 'running', worker_id = $1, attempts = attempts + 1,
            leased_until = now() + make_interval(secs => $2), started_at = coalesce(started_at, now())
      WHERE id = (
        SELECT id FROM export_jobs
         WHERE (status = 'queued' OR (status = 'running' AND leased_until < now()))
           AND cancel_requested_at IS NULL AND attempts < $3
         ORDER BY created_at
         FOR UPDATE SKIP LOCKED
         LIMIT 1)
      RETURNING id, org_id, created_by, query, attempts`,
    [workerId, config.exportLeaseSeconds, config.exportMaxAttempts],
  )
  return rows[0] ?? null
}

/** Jobs whose worker died too many times, or that were cancelled while running unattended. */
export async function failAbandonedJobs(): Promise<void> {
  const { rows } = await pool.query(
    `UPDATE export_jobs
        SET status = CASE WHEN cancel_requested_at IS NOT NULL THEN 'cancelled' ELSE 'failed' END,
            error_code = CASE WHEN cancel_requested_at IS NOT NULL THEN error_code ELSE 'WORKER_LOST' END,
            error_message = CASE WHEN cancel_requested_at IS NOT NULL THEN error_message
                                 ELSE 'The export stopped responding and was retried too many times' END,
            finished_at = now()
      WHERE status = 'running' AND leased_until < now()
        AND (attempts >= $1 OR cancel_requested_at IS NOT NULL)
      RETURNING id, org_id, created_by, status`,
    [config.exportMaxAttempts],
  )
  for (const job of rows) {
    exportsFinished.inc({ status: job.status })
    if (job.status === 'failed') {
      await publishUserEvent(job.created_by, { type: 'export.failed', orgId: job.org_id, exportId: job.id, error: 'WORKER_LOST' })
    }
  }
}

const CSV_HEADER = ['id', 'started_at', 'status', 'channel', 'agent', 'project', 'customer', 'subject', 'messages', 'csat']

/** Quotes a cell, and defuses spreadsheet formulas (a subject starting with "=" must not execute). */
export function csvCell(value: unknown): string {
  let text = value === null || value === undefined ? '' : value instanceof Date ? value.toISOString() : String(value)
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

async function checkAccess(job: ClaimedJob): Promise<EffectiveAccess> {
  const access = await computeFromDatabase(pool, job.created_by, job.org_id)
  if (!access || !access.permissions.includes('conversations.export') || !access.entitlements.exports) {
    throw new AccessLost()
  }
  return access
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

export async function runExport(job: ClaimedJob, workerId: string): Promise<void> {
  const log = logger.child({ exportId: job.id, orgId: job.org_id })
  const tmpPath = join(config.exportDir, `${job.id}.csv.part`)
  const finalPath = join(config.exportDir, `${job.id}.csv`)

  /** Renews the lease and records progress; throws if this worker no longer owns the job. */
  const heartbeat = async (processed: number, total: number | null) => {
    const { rows } = await pool.query(
      `UPDATE export_jobs SET processed_rows = $3, total_rows = coalesce($4, total_rows),
              leased_until = now() + make_interval(secs => $5)
        WHERE id = $1 AND worker_id = $2 AND status = 'running'
        RETURNING cancel_requested_at`,
      [job.id, workerId, processed, total, config.exportLeaseSeconds],
    )
    if (!rows[0]) throw new Fenced()
    if (rows[0].cancel_requested_at) throw new Cancelled()
  }

  try {
    const filters = conversationFiltersSchema.parse(job.query)
    const access = await checkAccess(job)
    const counted = buildConversationWhere(job.org_id, access.projectIds, filters)
    const { rows: countRows } = await pool.query(
      `SELECT count(*)::int AS n FROM conversations c WHERE ${counted.where}`,
      counted.params,
    )
    const total: number = countRows[0].n
    await heartbeat(0, total)
    await publishUserEvent(job.created_by, {
      type: 'export.progress',
      orgId: job.org_id,
      exportId: job.id,
      processedRows: 0,
      totalRows: total,
    })

    await mkdir(config.exportDir, { recursive: true })
    const out = createWriteStream(tmpPath, { encoding: 'utf8' })
    out.write(`${CSV_HEADER.join(',')}\n`)
    let processed = 0
    let cursor: Cursor | undefined
    for (;;) {
      const { where, params } = buildConversationWhere(job.org_id, access.projectIds, filters, cursor)
      const { rows } = await pool.query(
        `SELECT ${CONVERSATION_COLUMNS} ${CONVERSATION_FROM} WHERE ${where}
          ORDER BY c.started_at DESC, c.id DESC LIMIT ${config.exportBatchSize}`,
        params,
      )
      if (rows.length === 0) break
      for (const r of rows) {
        const line = [r.id, r.started_at, r.status, r.channel, r.agent_name, r.project_name, r.customer_name, r.subject, r.message_count, r.csat]
        if (!out.write(`${line.map(csvCell).join(',')}\n`)) await once(out, 'drain')
      }
      processed += rows.length
      const last = rows[rows.length - 1]
      cursor = { startedAt: (last.started_at as Date).toISOString(), id: last.id }
      await heartbeat(processed, null)
      await publishUserEvent(job.created_by, {
        type: 'export.progress',
        orgId: job.org_id,
        exportId: job.id,
        processedRows: processed,
        totalRows: Math.max(total, processed),
      })
      if (config.exportBatchDelayMs > 0) await sleep(config.exportBatchDelayMs)
    }
    out.end()
    await once(out, 'finish')

    // Access may have changed while the file was being written.
    await checkAccess(job)
    await rename(tmpPath, finalPath)
    const { size } = await stat(finalPath)
    const { rowCount } = await pool.query(
      `UPDATE export_jobs SET status = 'completed', processed_rows = $3, total_rows = $3, file_path = $4,
              file_bytes = $5, finished_at = now(), leased_until = NULL
        WHERE id = $1 AND worker_id = $2 AND status = 'running' AND cancel_requested_at IS NULL`,
      [job.id, workerId, processed, finalPath, size],
    )
    if (!rowCount) {
      await rm(finalPath, { force: true })
      throw new Fenced()
    }
    exportsFinished.inc({ status: 'completed' })
    log.info({ rows: processed, bytes: size }, 'export completed')
    await publishUserEvent(job.created_by, { type: 'export.completed', orgId: job.org_id, exportId: job.id, totalRows: processed })
  } catch (err) {
    await rm(tmpPath, { force: true })
    if (err instanceof Fenced) {
      log.warn('lost the lease; another worker owns this export now')
      return
    }
    const [status, code, message] =
      err instanceof Cancelled
        ? ['cancelled', 'CANCELLED', 'The export was cancelled']
        : err instanceof AccessLost
          ? ['failed', 'ACCESS_REVOKED', 'You no longer have permission to export from this organization']
          : ['failed', 'EXPORT_FAILED', 'The export failed; try again']
    if (status === 'failed' && code === 'EXPORT_FAILED') log.error({ err }, 'export failed')
    const { rowCount } = await pool.query(
      `UPDATE export_jobs SET status = $3, error_code = $4, error_message = $5, finished_at = now(), leased_until = NULL
        WHERE id = $1 AND worker_id = $2 AND status = 'running'`,
      [job.id, workerId, status, code, message],
    )
    if (rowCount) {
      exportsFinished.inc({ status })
      await publishUserEvent(job.created_by, { type: 'export.failed', orgId: job.org_id, exportId: job.id, error: code })
    }
  }
}
