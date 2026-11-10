/**
 * One job: attempts with their steps and timeline, re-run, approve, resolve, and the
 * resumable log stream.
 * @module api/routes/jobs
 */
import { Router } from 'express'
import { z } from 'zod'
import { requireRepoMaintainer, requireRepoRead, repoRole } from '../../shared/access.js'
import { userOf, type SessionUser } from '../../shared/auth.js'
import { config } from '../../shared/config.js'
import { pool } from '../../shared/db.js'
import { asyncHandler, notFound } from '../../shared/errors.js'
import { sseConnections } from '../../shared/metrics.js'
import { openSse, writeSse, writeSseComment } from '../../shared/sse.js'
import { decideApproval, rerun, resolveAttention } from '../../scheduling/engine.js'
import { subscribeLogs } from '../../logs/bus.js'
import { readLines } from '../../logs/read.js'
import { artifactDto, attemptDto, jobDto, runDto, type ArtifactDbRow, type AttemptDbRow, type JobDbRow, type RunDbRow } from '../services/dto.js'

export const jobsRouter = Router()

async function loadJob(jobId: string): Promise<JobDbRow> {
  const { rows } = await pool.query<JobDbRow>('SELECT * FROM jobs WHERE id = $1', [jobId])
  if (!rows[0]) throw notFound('Job')
  return rows[0]
}

async function readable(jobId: string, user: SessionUser) {
  const job = await loadJob(jobId)
  const role = await requireRepoRead(pool, user, job.repo_id).catch(() => {
    throw notFound('Job')
  })
  return { job, role }
}

jobsRouter.get(
  '/:jobId',
  asyncHandler(async (req, res) => {
    const { job, role } = await readable(req.params.jobId, userOf(req))
    const [run, attempts, steps, transitions, artifacts, streams, approvals] = await Promise.all([
      pool.query<RunDbRow>('SELECT * FROM workflow_runs WHERE id = $1', [job.run_id]),
      pool.query<AttemptDbRow>('SELECT * FROM job_attempts WHERE job_id = $1 ORDER BY attempt DESC', [job.id]),
      pool.query<{ attempt: number; step_index: number; name: string; idempotent: boolean; status: string; exit_code: number | null; started_at: Date | null; finished_at: Date | null }>(
        'SELECT attempt, step_index, name, idempotent, status, exit_code, started_at, finished_at FROM step_executions WHERE job_id = $1 ORDER BY attempt, step_index',
        [job.id],
      ),
      pool.query<{ id: number; attempt: number; from_status: string | null; to_status: string; reason: string | null; actor: string | null; at: Date }>('SELECT id, attempt, from_status, to_status, reason, actor, at FROM job_transitions WHERE job_id = $1 ORDER BY id', [job.id]),
      pool.query<ArtifactDbRow>('SELECT * FROM artifacts WHERE job_id = $1 ORDER BY attempt, name', [job.id]),
      pool.query<{ attempt: number; line_count: number; closed_at: Date | null; archived_at: Date | null; gap_chunks: number }>('SELECT attempt, line_count, closed_at, archived_at, gap_chunks FROM log_streams WHERE job_id = $1', [job.id]),
      pool.query<{ attempt: number; decision: string; decided_by: string; comment: string | null; decided_at: Date }>('SELECT attempt, decision, decided_by, comment, decided_at FROM environment_approvals WHERE job_id = $1', [job.id]),
    ])
    res.json({
      canManage: role === 'maintainer',
      run: runDto(run.rows[0]),
      job: jobDto(job),
      attempts: attempts.rows.map((a) => {
        const log = streams.rows.find((s) => s.attempt === a.attempt)
        const approval = approvals.rows.find((p) => p.attempt === a.attempt)
        return {
          ...attemptDto(a),
          steps: steps.rows.filter((s) => s.attempt === a.attempt).map((s) => ({ index: s.step_index, name: s.name, idempotent: s.idempotent, status: s.status, exitCode: s.exit_code, startedAt: s.started_at?.toISOString() ?? null, finishedAt: s.finished_at?.toISOString() ?? null })),
          transitions: transitions.rows.filter((t) => t.attempt === a.attempt).map((t) => ({ id: t.id, from: t.from_status, to: t.to_status, reason: t.reason, actor: t.actor, at: t.at.toISOString() })),
          artifacts: artifacts.rows.filter((x) => x.attempt === a.attempt).map(artifactDto),
          log: log ? { lineCount: log.line_count, closed: log.closed_at !== null, archived: log.archived_at !== null, gapChunks: log.gap_chunks } : null,
          approval: approval ? { decision: approval.decision, by: approval.decided_by, comment: approval.comment, at: approval.decided_at.toISOString() } : null,
        }
      }),
    })
  }),
)

const rerunSchema = z.object({ confirmNonIdempotent: z.boolean().default(false) }).strict()

jobsRouter.post(
  '/:jobId/rerun',
  asyncHandler(async (req, res) => {
    const user = userOf(req)
    const job = await loadJob(req.params.jobId)
    await requireRepoMaintainer(pool, user, job.repo_id)
    const body = rerunSchema.parse(req.body ?? {})
    res.json(await rerun({ runId: job.run_id, mode: 'job', jobKey: job.job_key, actor: user.username, confirmNonIdempotent: body.confirmNonIdempotent }))
  }),
)

const approvalSchema = z.object({ decision: z.enum(['approved', 'rejected']), comment: z.string().max(500).nullable().optional() }).strict()

jobsRouter.post(
  '/:jobId/approval',
  asyncHandler(async (req, res) => {
    const user = userOf(req)
    const job = await loadJob(req.params.jobId)
    await requireRepoMaintainer(pool, user, job.repo_id)
    const body = approvalSchema.parse(req.body)
    res.json(await decideApproval(job.id, body.decision, user.username, body.comment ?? null))
  }),
)

const resolveSchema = z.object({ decision: z.enum(['succeeded', 'failed', 'retry']), note: z.string().max(500).nullable().optional(), confirmRetry: z.boolean().default(false) }).strict()

jobsRouter.post(
  '/:jobId/resolve',
  asyncHandler(async (req, res) => {
    const user = userOf(req)
    const job = await loadJob(req.params.jobId)
    await requireRepoMaintainer(pool, user, job.repo_id)
    const body = resolveSchema.parse(req.body)
    res.json(await resolveAttention({ jobId: job.id, decision: body.decision, note: body.note ?? null, actor: user.username, confirmRetry: body.confirmRetry }))
  }),
)

/**
 * The log stream. `id:` on every line is its offset, so a reconnect with Last-Event-ID
 * receives exactly what it missed, from any API instance, and the same endpoint keeps
 * working after the log moves to MinIO. PostgreSQL is what's read; Valkey only says "look now".
 */
jobsRouter.get(
  '/:jobId/attempts/:attempt/logs/stream',
  asyncHandler(async (req, res) => {
    const user = userOf(req)
    const { job } = await readable(req.params.jobId, user)
    const attempt = z.coerce.number().int().positive().parse(req.params.attempt)
    const header = req.get('Last-Event-ID')
    let cursor = Math.max(0, Number.parseInt(header ?? '0', 10) || 0)
    const resumed = cursor

    openSse(res)
    sseConnections.inc()
    const closed = { value: false }
    let wake: (() => void) | null = null
    const nudge = () => wake?.()
    const unsubscribe = subscribeLogs(job.id, attempt, nudge)
    req.on('close', () => {
      closed.value = true
      nudge()
    })
    writeSse(res, 'hello', { servedBy: config.instanceId, resumedAfter: resumed })

    let lastAccessCheck = Date.now()
    let lastBeat = Date.now()
    try {
      while (!closed.value) {
        const { lines, complete, source, lastLine } = await readLines(job.id, attempt, cursor)
        for (const line of lines) {
          writeSse(res, 'line', line, line.n)
          cursor = line.n
        }
        if (complete) {
          writeSse(res, 'end', { lastLine, source }, cursor)
          break
        }
        if (lines.length > 0) continue

        if (Date.now() - lastAccessCheck > config.logs.accessRecheckMs) {
          lastAccessCheck = Date.now()
          if (!(await repoRole(pool, user, job.repo_id))) {
            writeSse(res, 'revoked', { message: 'You no longer have access to this repository' })
            break
          }
        }
        if (Date.now() - lastBeat > 15_000) {
          lastBeat = Date.now()
          writeSseComment(res, 'keep-alive')
        }
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, config.logs.pollMs)
          wake = () => {
            clearTimeout(timer)
            wake = null
            resolve()
          }
        })
      }
    } finally {
      unsubscribe()
      sseConnections.dec()
      res.end()
    }
  }),
)
