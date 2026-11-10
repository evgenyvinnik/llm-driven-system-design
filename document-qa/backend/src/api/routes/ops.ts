/**
 * Operator view: queue depth, jobs by stage and status, poisoned jobs with
 * retry, purge backlog, index-metadata lag, recent run usage, and the fault
 * switches for workers and the mock services. Operators see ids and counts,
 * never document titles, text or questions.
 * @module api/routes/ops
 */
import { Router } from 'express'
import { z } from 'zod'
import { config } from '../../shared/config.js'
import { CHAOS_SWITCHES, readAll, setSwitch } from '../../shared/chaos.js'
import { pool, withTransaction } from '../../shared/db.js'
import { asyncHandler, HttpError } from '../../shared/errors.js'
import { requireOperator } from '../../shared/auth.js'
import { retryPoisoned } from '../../pipeline/jobs.js'
import { purgeStateFor } from '../services/documents.js'
import { publishJobs } from '../services/publish.js'

export const opsRouter = Router()
opsRouter.use(requireOperator)

async function queueDepth(): Promise<{ ready: number; unacked: number; consumers: number; poison: number } | null> {
  try {
    const base = new URL(config.rabbitMgmtUrl)
    const auth = Buffer.from(`${decodeURIComponent(base.username)}:${decodeURIComponent(base.password)}`).toString('base64')
    const origin = `${base.protocol}//${base.host}`
    const get = async (queue: string) => {
      const r = await fetch(`${origin}/api/queues/%2F/${encodeURIComponent(queue)}`, { headers: { Authorization: `Basic ${auth}` }, signal: AbortSignal.timeout(1500) })
      if (!r.ok) return null
      return (await r.json()) as { messages_ready?: number; messages_unacknowledged?: number; consumers?: number; messages?: number }
    }
    const [main, poison] = await Promise.all([get(config.queue.pipeline), get(config.queue.poison)])
    if (!main) return null
    return { ready: main.messages_ready ?? 0, unacked: main.messages_unacknowledged ?? 0, consumers: main.consumers ?? 0, poison: poison?.messages ?? 0 }
  } catch {
    return null
  }
}

async function serviceSettings(url: string): Promise<Record<string, unknown> | null> {
  try {
    const r = await fetch(`${url}/_control/settings`, { signal: AbortSignal.timeout(1500) })
    return r.ok ? ((await r.json()) as Record<string, unknown>) : null
  } catch {
    return null
  }
}

opsRouter.get(
  '/overview',
  asyncHandler(async (_req, res) => {
    const [queue, matrix, poisoned, backlog, stale, runs, chaos, embedder, model, workers] = await Promise.all([
      queueDepth(),
      pool.query<{ stage: string; status: string; n: number }>(`SELECT stage, status, count(*)::int AS n FROM processing_jobs GROUP BY stage, status`),
      pool.query(
        `SELECT j.id, j.document_id, j.version_id, j.stage, j.attempts, j.max_attempts, j.last_error, j.finished_at, o.name AS org_name
           FROM processing_jobs j JOIN orgs o ON o.id = j.org_id WHERE j.status = 'poisoned' ORDER BY j.finished_at DESC NULLS LAST LIMIT 20`,
      ),
      pool.query<{ id: string; org_name: string; deleted_at: Date; purge_completed_at: Date | null }>(
        `SELECT d.id, o.name AS org_name, d.deleted_at, d.purge_completed_at FROM documents d JOIN orgs o ON o.id = d.org_id
          WHERE d.deleted_at IS NOT NULL ORDER BY (d.purge_completed_at IS NULL) DESC, d.deleted_at DESC LIMIT 15`,
      ),
      pool.query<{ rows: number; documents: number; oldest: Date | null }>(
        `SELECT count(*)::int AS rows, count(DISTINCT e.document_id)::int AS documents, min(d.updated_at) AS oldest
           FROM index_entries e JOIN documents d ON d.id = e.document_id WHERE e.acl_epoch < d.acl_epoch AND d.deleted_at IS NULL`,
      ),
      pool.query(
        `SELECT id, status, cache->>'status' AS cache_status, input_tokens, output_tokens, queue_ms, retrieval_ms, ttft_ms, generation_ms, created_at,
                (SELECT count(*)::int FROM jsonb_array_elements(citations)) AS citations
           FROM answer_runs ORDER BY created_at DESC LIMIT 15`,
      ),
      readAll(),
      serviceSettings(config.embedderUrl),
      serviceSettings(config.modelUrl),
      pool.query<{ worker: string; running: number }>(
        `SELECT lease_owner AS worker, count(*)::int AS running FROM processing_jobs WHERE status = 'running' AND lease_owner IS NOT NULL GROUP BY lease_owner`,
      ),
    ])
    const purge = await purgeStateFor(
      pool,
      backlog.rows.map((r) => r.id),
    )
    res.json({
      queue,
      jobs: matrix.rows,
      runningByWorker: workers.rows,
      poisoned: poisoned.rows.map((j) => ({
        id: j.id,
        documentId: j.document_id,
        versionId: j.version_id,
        stage: j.stage,
        attempts: j.attempts,
        maxAttempts: j.max_attempts,
        lastError: j.last_error,
        finishedAt: j.finished_at ? new Date(j.finished_at).toISOString() : null,
        orgName: j.org_name,
      })),
      purgeBacklog: backlog.rows.map((d) => ({
        documentId: d.id,
        orgName: d.org_name,
        deletedAt: d.deleted_at.toISOString(),
        purgeCompletedAt: d.purge_completed_at ? d.purge_completed_at.toISOString() : null,
        purge: purge.get(d.id) ?? null,
      })),
      staleIndex: { rows: stale.rows[0].rows, documents: stale.rows[0].documents, oldestChangeAt: stale.rows[0].oldest ? stale.rows[0].oldest.toISOString() : null },
      runs: runs.rows.map((r) => ({
        id: r.id,
        status: r.status,
        cacheStatus: r.cache_status,
        citations: r.citations,
        inputTokens: r.input_tokens,
        outputTokens: r.output_tokens,
        queueMs: r.queue_ms,
        retrievalMs: r.retrieval_ms,
        ttftMs: r.ttft_ms,
        generationMs: r.generation_ms,
        createdAt: new Date(r.created_at).toISOString(),
      })),
      chaos,
      embedder,
      model,
    })
  }),
)

opsRouter.post(
  '/jobs/:id/retry',
  asyncHandler(async (req, res) => {
    const jobIds = await withTransaction(async (client) => {
      const { rows } = await client.query<{ version_id: string | null; document_id: string; stage: string }>(
        `SELECT j.version_id, j.document_id, j.stage FROM processing_jobs j JOIN documents d ON d.id = j.document_id
          WHERE j.id = $1 AND (d.deleted_at IS NULL OR j.stage = 'purge')`,
        [req.params.id],
      )
      if (!rows[0]) throw new HttpError(404, 'NOT_FOUND', 'Job not found')
      const id = await retryPoisoned(client, req.params.id)
      if (!id) throw new HttpError(409, 'NOT_POISONED', 'Only poisoned jobs can be retried')
      if (rows[0].version_id && ['extract', 'chunk', 'embed', 'index'].includes(rows[0].stage)) {
        await client.query(`UPDATE document_versions SET status = 'processing', failure_reason = NULL WHERE id = $1`, [rows[0].version_id])
        await client.query(`UPDATE documents SET status = 'processing', failure_reason = NULL WHERE id = $1 AND current_version_id IS NULL`, [rows[0].document_id])
      }
      return [id]
    })
    await publishJobs(jobIds)
    res.json({ retried: jobIds.length })
  }),
)

const chaosSchema = z.object({ name: z.enum(CHAOS_SWITCHES), value: z.number().int().min(0).max(600_000) })

opsRouter.put(
  '/chaos',
  asyncHandler(async (req, res) => {
    const { name, value } = chaosSchema.parse(req.body)
    await setSwitch(name, value)
    res.json({ chaos: await readAll() })
  }),
)

async function proxySettings(url: string, body: unknown): Promise<unknown> {
  const r = await fetch(`${url}/_control/settings`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
    signal: AbortSignal.timeout(2000),
  }).catch(() => null)
  if (!r) throw new HttpError(502, 'SERVICE_UNREACHABLE', 'Mock service is not reachable')
  const data = await r.json().catch(() => ({}))
  if (!r.ok) throw new HttpError(r.status, 'SERVICE_REJECTED', 'Mock service rejected the settings', data)
  return data
}

opsRouter.put(
  '/embedder',
  asyncHandler(async (req, res) => {
    res.json(await proxySettings(config.embedderUrl, req.body))
  }),
)

opsRouter.put(
  '/model',
  asyncHandler(async (req, res) => {
    res.json(await proxySettings(config.modelUrl, req.body))
  }),
)
