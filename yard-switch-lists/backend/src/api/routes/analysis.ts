/**
 * Shift metrics, planner comparisons and seeded replays.
 */
import { Router } from 'express'
import { z } from 'zod'
import { requireAuth, requireRole } from '../../shared/auth.js'
import { pool } from '../../shared/db.js'
import { asyncHandler } from '../../shared/errors.js'
import { shiftMetrics } from '../../metrics/shift.js'
import { readYard } from '../../plans/state.js'
import { enqueueSolve } from '../../worker/jobs.js'

export const analysisRouter = Router()

analysisRouter.get(
  '/metrics/shifts',
  requireAuth,
  asyncHandler(async (_req, res) => {
    const yard = await readYard(pool)
    const { rows } = await pool.query(`SELECT id FROM shifts ORDER BY id DESC LIMIT 20`)
    const shifts = []
    for (const r of rows) shifts.push(await shiftMetrics(pool, r.id, r.id === yard.shiftId ? yard.simNow : null))
    res.json({ currentShiftId: yard.shiftId, shifts })
  }),
)

analysisRouter.post(
  '/comparisons',
  requireRole('yardmaster'),
  asyncHandler(async (req, res) => {
    const params = z
      .object({ smallInstances: z.number().int().min(1).max(20).optional(), exactLimitMs: z.number().int().min(100).max(60_000).optional(), fullSeed: z.number().int().optional(), fullLimits: z.array(z.number().int().min(10).max(30_000)).max(8).optional() })
      .parse(req.body ?? {})
    const yard = await readYard(pool)
    const id = await enqueueSolve(pool, { shiftId: yard.shiftId, lane: 'analysis', purpose: 'compare', algorithm: 'compare', reason: 'planner comparison', timeLimitMs: params.exactLimitMs ?? 12_000, iterationLimit: 0, seed: yard.seed, params })
    res.status(202).json({ jobId: id })
  }),
)

analysisRouter.get(
  '/comparisons/latest',
  requireAuth,
  asyncHandler(async (_req, res) => {
    const { rows: runs } = await pool.query(`SELECT * FROM comparison_runs ORDER BY created_at DESC LIMIT 1`)
    const { rows: active } = await pool.query(`SELECT id, status, queued_at FROM solve_jobs WHERE purpose = 'compare' AND status IN ('queued', 'running') ORDER BY queued_at DESC LIMIT 1`)
    const run = runs[0]
    if (!run) {
      res.json({ run: null, rows: [], active: active[0] ?? null })
      return
    }
    const { rows } = await pool.query(`SELECT * FROM comparison_rows WHERE run_id = $1 ORDER BY kind DESC, instance, time_limit_ms, algorithm`, [run.id])
    res.json({
      run: { id: run.id, status: run.status, params: run.params, summary: run.summary, createdAt: run.created_at, finishedAt: run.finished_at },
      active: active[0] ?? null,
      rows: rows.map((r) => ({ instance: r.instance, kind: r.kind, algorithm: r.algorithm, timeLimitMs: r.time_limit_ms, cost: r.cost, elapsedMs: r.elapsed_ms, iterations: r.iterations, terminatedBy: r.terminated_by, provenOptimal: r.proven_optimal, gapPct: r.gap_pct, valid: r.valid, moves: r.moves })),
    })
  }),
)

analysisRouter.post(
  '/replays',
  requireRole('yardmaster'),
  asyncHandler(async (req, res) => {
    const params = z.object({ seeds: z.array(z.number().int()).min(1).max(12).optional(), iterations: z.number().int().min(50).max(20_000).optional() }).parse(req.body ?? {})
    const yard = await readYard(pool)
    const id = await enqueueSolve(pool, { shiftId: yard.shiftId, lane: 'analysis', purpose: 'replay', algorithm: 'replay', reason: 'seeded replay', timeLimitMs: 0, iterationLimit: params.iterations ?? 800, seed: yard.seed, params })
    res.status(202).json({ jobId: id })
  }),
)

analysisRouter.get(
  '/replays/latest',
  requireAuth,
  asyncHandler(async (_req, res) => {
    const { rows: runs } = await pool.query(`SELECT * FROM replay_runs ORDER BY created_at DESC LIMIT 1`)
    const { rows: active } = await pool.query(`SELECT id, status, queued_at FROM solve_jobs WHERE purpose = 'replay' AND status IN ('queued', 'running') ORDER BY queued_at DESC LIMIT 1`)
    const run = runs[0]
    res.json({ run: run ? { id: run.id, status: run.status, params: run.params, summary: run.summary, createdAt: run.created_at, finishedAt: run.finished_at } : null, active: active[0] ?? null })
  }),
)
