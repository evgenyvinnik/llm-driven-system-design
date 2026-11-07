/**
 * The mock model and mock judge, seen through the API: call counters, chaos
 * switches and latency settings, plus queue depth. Shared local infrastructure,
 * so any signed-in user can view it; production would restrict it to operators.
 */
import { Router } from 'express'
import { z } from 'zod'
import { requireAuth } from '../../shared/auth.js'
import { CHAOS_KINDS } from '../../shared/chaos.js'
import { config } from '../../shared/config.js'
import { pool } from '../../shared/db.js'
import { asyncHandler, HttpError } from '../../shared/errors.js'

export const systemRouter = Router()
systemRouter.use(requireAuth)

const target = z.enum(['model', 'judge'])
const baseUrl = (t: 'model' | 'judge') => (t === 'model' ? config.modelUrl : config.judgeUrl)

async function forward(url: string, init?: RequestInit): Promise<unknown> {
  try {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(3000), headers: { 'Content-Type': 'application/json' } })
    return await res.json()
  } catch {
    return null
  }
}

systemRouter.get(
  '/system',
  asyncHandler(async (_req, res) => {
    const [model, judge, queue] = await Promise.all([
      forward(`${config.modelUrl}/admin/state`),
      forward(`${config.judgeUrl}/admin/state`),
      pool.query<{ pending: number; running: number; scores_pending: number; active_runs: number }>(
        `SELECT (SELECT count(*) FROM case_results WHERE status = 'pending') AS pending,
                (SELECT count(*) FROM case_results WHERE status = 'running' AND lease_expires_at > now()) AS running,
                (SELECT count(*) FROM scores WHERE status IN ('pending', 'running')) AS scores_pending,
                (SELECT count(*) FROM eval_runs WHERE status IN ('queued', 'running')) AS active_runs`,
      ),
    ])
    const q = queue.rows[0]
    res.json({ model, judge, queue: { pendingTasks: q.pending, liveLeases: q.running, pendingScores: q.scores_pending, activeRuns: q.active_runs } })
  }),
)

const countsSchema = z.record(z.enum(CHAOS_KINDS), z.number().min(0).max(1000))

systemRouter.put(
  '/system/:target/chaos',
  asyncHandler(async (req, res) => {
    const t = target.parse(req.params.target)
    const body = z.object({ armed: countsSchema.optional(), rates: countsSchema.optional() }).parse(req.body)
    const state = await forward(`${baseUrl(t)}/admin/chaos`, { method: 'PUT', body: JSON.stringify(body) })
    if (!state) throw new HttpError(502, 'MOCK_UNREACHABLE', `The mock ${t} is not reachable`)
    res.json(state)
  }),
)

systemRouter.post(
  '/system/:target/chaos/reset',
  asyncHandler(async (req, res) => {
    const t = target.parse(req.params.target)
    const state = await forward(`${baseUrl(t)}/admin/chaos/reset`, { method: 'POST' })
    if (!state) throw new HttpError(502, 'MOCK_UNREACHABLE', `The mock ${t} is not reachable`)
    res.json(state)
  }),
)
