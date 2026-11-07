/**
 * Answer runs: create (202 + server-assigned id), list, get, stream (SSE,
 * resumable with Last-Event-ID from any API instance) and cancel.
 *
 * History is re-validated on read: a past answer whose prompt included a
 * document the reader can no longer read (deleted, unshared, removed from the
 * group) is returned redacted, before the purge job scrubs it for good.
 * @module api/routes/answers
 */
import { Router } from 'express'
import { z } from 'zod'
import { accessDecision } from '../../shared/access.js'
import { pool } from '../../shared/db.js'
import { asyncHandler, HttpError, notFound } from '../../shared/errors.js'
import { newId } from '../../shared/ids.js'
import { logger } from '../../shared/logger.js'
import { openSse, writeSse, writeSseComment } from '../../shared/sse.js'
import { principal, requireMember } from '../../shared/auth.js'
import { loadDocTruth, loadLiveAccess } from '../services/answer-cache.js'
import { executeRun, abortLocal } from '../services/answer-runner.js'
import { runDto, type RunRow } from '../services/dto.js'
import { publishCancel, readEvents } from '../services/run-events.js'

export const answersRouter = Router()
answersRouter.use(requireMember)

const askSchema = z.object({ question: z.string().trim().min(3).max(1000) })

/** Strips internal retrieval detail (ids of dropped documents) from what the asker sees. */
function publicRun(r: RunRow, redaction: string | null) {
  // After a purge the stored text itself is gone; say why instead of showing an empty answer.
  const scrubbed = typeof r.cache?.scrubbed === 'string' ? 'A source document of this answer was deleted.' : null
  const dto = runDto(r, redaction ?? scrubbed)
  const { droppedDocs: _d, ...retrieval } = (dto.retrieval ?? {}) as Record<string, unknown>
  return { ...dto, retrieval }
}

async function redactions(rows: RunRow[], userId: string): Promise<Map<string, string>> {
  const ids = [...new Set(rows.flatMap((r) => (r.sources ?? []).map((s) => s.documentId)))]
  const out = new Map<string, string>()
  if (ids.length === 0) return out
  const [truth, live] = await Promise.all([loadDocTruth(ids), loadLiveAccess(userId)])
  for (const r of rows) {
    for (const s of r.sources ?? []) {
      const doc = truth.get(s.documentId)
      const decision = doc ? accessDecision(doc, live.user, live.groups) : ({ allowed: false, reason: 'deleted' } as const)
      if (!decision.allowed) {
        out.set(r.id, decision.reason === 'deleted' ? 'A source document of this answer was deleted.' : 'You no longer have access to a source document of this answer.')
        break
      }
    }
  }
  return out
}

answersRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const { orgId, userId, user } = principal(req)
    const { question } = askSchema.parse(req.body)
    const id = newId.run()
    const { rows } = await pool.query<RunRow>(`INSERT INTO answer_runs (id, org_id, user_id, question) VALUES ($1, $2, $3, $4) RETURNING *`, [id, orgId, userId, question])
    void executeRun(id, { orgId, userId, claimedGroups: user.groupIds }).catch((err) => logger.error({ err: (err as Error).message, runId: id }, 'run executor crashed'))
    res.status(202).json({ run: publicRun(rows[0], null) })
  }),
)

answersRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const { userId } = principal(req)
    const { rows } = await pool.query<RunRow>(`SELECT * FROM answer_runs WHERE user_id = $1 ORDER BY created_at DESC LIMIT 30`, [userId])
    const hidden = await redactions(rows, userId)
    res.json({ runs: rows.map((r) => publicRun(r, hidden.get(r.id) ?? null)) })
  }),
)

async function ownRun(id: string, userId: string): Promise<RunRow> {
  const { rows } = await pool.query<RunRow>(`SELECT * FROM answer_runs WHERE id = $1 AND user_id = $2`, [id, userId])
  if (!rows[0]) throw notFound('Answer run')
  return rows[0]
}

answersRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const { userId } = principal(req)
    const run = await ownRun(req.params.id, userId)
    const hidden = await redactions([run], userId)
    res.json({ run: publicRun(run, hidden.get(run.id) ?? null) })
  }),
)

answersRouter.get(
  '/:id/stream',
  asyncHandler(async (req, res) => {
    const { userId } = principal(req)
    const run = await ownRun(req.params.id, userId)
    const from = req.get('last-event-id') || (typeof req.query.after === 'string' ? req.query.after : '') || '0'
    openSse(res)
    writeSse(res, 'snapshot', { status: run.status })
    const ac = new AbortController()
    req.on('close', () => ac.abort())
    const ping = setInterval(() => writeSseComment(res, 'ping'), 15_000)
    try {
      for await (const ev of readEvents(run.id, from, ac.signal)) writeSse(res, ev.type, ev.data, ev.id)
    } finally {
      clearInterval(ping)
      res.end()
    }
  }),
)

answersRouter.post(
  '/:id/cancel',
  asyncHandler(async (req, res) => {
    const { userId } = principal(req)
    const { rows } = await pool.query<{ id: string; status: string }>(
      `UPDATE answer_runs SET cancel_requested_at = COALESCE(cancel_requested_at, now())
        WHERE id = $1 AND user_id = $2 AND status IN ('queued', 'running') RETURNING id, status`,
      [req.params.id, userId],
    )
    if (!rows[0]) {
      await ownRun(req.params.id, userId)
      throw new HttpError(409, 'NOT_RUNNING', 'This answer already finished')
    }
    if (!abortLocal(rows[0].id)) await publishCancel(rows[0].id)
    res.status(202).json({ cancelRequested: true })
  }),
)
