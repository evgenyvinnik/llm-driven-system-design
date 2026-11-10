/**
 * Plan versions, diffs, publish, edits, locks and solves.
 */
import { Router } from 'express'
import { z } from 'zod'
import { requireAuth, requireRole } from '../../shared/auth.js'
import { pool, withSnapshotRead, withTransaction } from '../../shared/db.js'
import { asyncHandler, HttpError, notFound } from '../../shared/errors.js'
import { config } from '../../shared/config.js'
import { hash32 } from '../../shared/rng.js'
import { diffMoves } from '../../domain/diff.js'
import { versionDto, moveDto } from '../../plans/board.js'
import { applyEdit, previewEdit, recordRefusal, type EditRequest } from '../../plans/edits.js'
import { explainChange, triggersFor } from '../../plans/explain.js'
import { createLock, releaseLock } from '../../plans/locks.js'
import { readSnapshotWith } from '../../plans/snapshot.js'
import { addTrigger, readYard } from '../../plans/state.js'
import { loadMoves, loadVersion, mapVersion, publishOrRecompute } from '../../plans/versions.js'
import { enqueueSolve } from '../../worker/jobs.js'
import { plannerLimits } from '../../worker/coalescer.js'

export const plansRouter = Router()

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const reasonCode = z.enum(['protect_departure', 'track_condition', 'crew_availability', 'customer_priority', 'planner_wrong', 'crew_preference', 'radio_information', 'safety_concern', 'other'])

async function resolveVersionId(id: string): Promise<string> {
  if (id === 'latest-replan') {
    const { rows } = await pool.query(
      `SELECT id FROM switch_lists WHERE stability IS NOT NULL AND shift_id = (SELECT shift_id FROM yard_state LIMIT 1)
       ORDER BY (reason LIKE '%late_train%') DESC, version_no DESC LIMIT 1`,
    )
    if (!rows[0]) throw notFound('Replan')
    return rows[0].id
  }
  if (id === 'working' || id === 'head') {
    const yard = await readYard(pool)
    const found = id === 'working' ? yard.workingVersionId : yard.headVersionId
    if (!found) throw notFound('Plan version')
    return found
  }
  if (!UUID.test(id)) throw notFound('Plan version')
  return id
}

plansRouter.get(
  '/plans',
  requireAuth,
  asyncHandler(async (_req, res) => {
    const yard = await readYard(pool)
    const { rows } = await pool.query(`SELECT * FROM switch_lists WHERE shift_id = $1 ORDER BY version_no DESC LIMIT 100`, [yard.shiftId])
    const versions = rows.map(mapVersion)
    const counts = await pool.query(`SELECT list_id, count(*)::int AS n FROM moves WHERE list_id = ANY($1) GROUP BY list_id`, [versions.map((v) => v.id)])
    const moveCount = new Map(counts.rows.map((c) => [c.list_id, c.n]))
    res.json({
      stateVersion: yard.stateVersion,
      headVersionId: yard.headVersionId,
      workingVersionId: yard.workingVersionId,
      versions: versions.map((v) => ({ ...versionDto(v), moveCount: moveCount.get(v.id) ?? 0 })),
    })
  }),
)

plansRouter.get(
  '/plans/:id',
  requireAuth,
  asyncHandler(async (req, res) => {
    const id = await resolveVersionId(req.params.id)
    const body = await withSnapshotRead(async (client) => {
      const version = await loadVersion(client, id)
      if (!version) throw notFound('Plan version')
      const moves = await loadMoves(client, id)
      const snapshot = await readSnapshotWith(client)
      const held = new Set(snapshot.cars.filter((c) => c.held).map((c) => c.id))
      const locks = new Map(snapshot.locks.filter((l) => l.kind === 'move' && l.moveKey).map((l) => [l.moveKey as string, l.id]))
      const parent = version.parentId ? await loadVersion(client, version.parentId) : null
      return { version: versionDto(version), parentVersionNo: parent?.versionNo ?? null, stateVersion: snapshot.stateVersion, moves: moves.map((m) => moveDto(m, snapshot, locks, held)) }
    })
    res.json(body)
  }),
)

plansRouter.get(
  '/plans/:id/diff',
  requireAuth,
  asyncHandler(async (req, res) => {
    const id = await resolveVersionId(req.params.id)
    const version = await loadVersion(pool, id)
    if (!version) throw notFound('Plan version')
    const againstId = typeof req.query.against === 'string' && UUID.test(req.query.against) ? req.query.against : version.parentId
    if (!againstId) {
      res.json({ from: null, to: versionDto(version), changes: [], counts: null, triggers: [], frozen: [] })
      return
    }
    const against = await loadVersion(pool, againstId)
    if (!against) throw notFound('Comparison version')
    const [before, after] = await Promise.all([loadMoves(pool, againstId), loadMoves(pool, id)])
    const { changes, counts } = diffMoves(before, after)
    const triggers = await triggersFor(pool, version.solveId)
    const { rows: execs } = await pool.query(`SELECT key, status FROM move_executions WHERE shift_id = $1 AND status IN ('done', 'in_progress')`, [version.shiftId])
    const frozen = execs.map((e) => e.key as string)
    const iso = (ms: number | undefined) => (ms === undefined ? null : new Date(ms).toISOString())
    const dto = (m: (typeof before)[number] | null) =>
      m ? { key: m.key, kind: m.kind, carCount: m.carIds.length, carIds: m.carIds, fromTrackId: m.fromTrackId, toTrackId: m.toTrackId, outboundId: m.outboundId, blockId: m.blockId, plannedStart: iso(m.plannedStart), plannedEnd: iso(m.plannedEnd) } : null
    res.json({
      from: versionDto(against),
      to: versionDto(version),
      counts,
      triggers,
      frozen,
      changes: changes.map((c) => ({
        key: c.key,
        type: c.type,
        fields: c.fields,
        shiftMin: c.shiftMin,
        frozen: frozen.includes(c.key),
        before: dto(c.before),
        after: dto(c.after),
        why: c.type === 'kept' ? (Math.abs(c.shiftMin) > 1 ? `Same move, ${Math.abs(c.shiftMin)} min ${c.shiftMin > 0 ? 'later' : 'earlier'}` : 'Left alone') : explainChange(c, triggers),
      })),
    })
  }),
)

plansRouter.post(
  '/plans/:id/publish',
  requireRole('yardmaster'),
  asyncHandler(async (req, res) => {
    const body = z.object({ expectedStateVersion: z.number().int().optional() }).parse(req.body ?? {})
    const id = await resolveVersionId(req.params.id)
    const version = await publishOrRecompute(id, { by: req.user!.username, expectedStateVersion: body.expectedStateVersion })
    res.json({ version: versionDto(version) })
  }),
)

plansRouter.post(
  '/plans/:id/discard',
  requireRole('yardmaster'),
  asyncHandler(async (req, res) => {
    const id = await resolveVersionId(req.params.id)
    const out = await withTransaction(async (client) => {
      const yard = await readYard(client, true)
      const version = await loadVersion(client, id)
      if (!version) throw notFound('Plan version')
      if (version.status !== 'draft') throw new HttpError(409, 'NOT_DRAFT', 'Only a draft can be discarded')
      await client.query(`UPDATE switch_lists SET status = 'superseded', superseded_at = now() WHERE id = $1`, [id])
      if (yard.workingVersionId === id) await client.query(`UPDATE yard_state SET working_version_id = head_version_id`)
      await client.query(`UPDATE alerts SET status = 'resolved', resolved_at = now() WHERE kind = 'plan_needs_review' AND status <> 'resolved'`)
      return version
    })
    res.json({ discarded: out.versionNo })
  }),
)

const editOp = z.union([
  z.object({ op: z.literal('reorder'), moveKey: z.string().min(1), toIndex: z.number().int().min(0) }),
  z.object({ op: z.literal('retarget'), moveKey: z.string().min(1), toTrackId: z.string().min(1) }),
])
const editSchema = z.object({
  expectedVersionNo: z.number().int(),
  ops: z.array(editOp).min(1).max(20),
  reason: z.string().trim().min(3).max(500),
  reasonCode,
  overrideSoft: z.boolean().optional(),
})

plansRouter.post(
  '/plans/:id/edits',
  requireRole('yardmaster'),
  asyncHandler(async (req, res) => {
    const id = await resolveVersionId(req.params.id)
    const body = editSchema.parse(req.body) as EditRequest
    try {
      const outcome = await withTransaction((client) => applyEdit(client, id, body, req.user!.username))
      res.status(201).json({ version: versionDto(outcome.version), validation: { ok: outcome.validation.ok, violations: outcome.validation.violations, readiness: outcome.validation.readiness }, pinned: outcome.pinned })
    } catch (err) {
      if (err instanceof HttpError && ['EDIT_REFUSED', 'VERSION_CONFLICT'].includes(err.code)) {
        await withTransaction((client) => recordRefusal(client, id, body, req.user!.username, err.code, (err.details as { violations?: unknown })?.violations))
      }
      throw err
    }
  }),
)

plansRouter.post(
  '/plans/:id/preview',
  requireRole('yardmaster'),
  asyncHandler(async (req, res) => {
    const id = await resolveVersionId(req.params.id)
    const { ops } = z.object({ ops: z.array(editOp).min(1).max(20) }).parse(req.body)
    const client = await pool.connect()
    try {
      const result = await previewEdit(client, id, ops)
      res.json({ ok: result.ok, violations: result.violations, readiness: result.readiness })
    } finally {
      client.release()
    }
  }),
)

// ── Locks ───────────────────────────────────────────────────────────────

const lockSchema = z.object({
  kind: z.enum(['move', 'car_track']),
  moveKey: z.string().optional(),
  carId: z.string().optional(),
  trackId: z.string().optional(),
  reason: z.string().trim().min(3).max(500),
  reasonCode,
  overrideSoft: z.boolean().optional(),
})

plansRouter.post(
  '/locks',
  requireRole('yardmaster'),
  asyncHandler(async (req, res) => {
    const body = lockSchema.parse(req.body)
    const result = await withTransaction((client) => createLock(client, body, req.user!.username))
    res.status(201).json(result)
  }),
)

plansRouter.post(
  '/locks/:id/release',
  requireRole('yardmaster'),
  asyncHandler(async (req, res) => {
    if (!UUID.test(req.params.id)) throw notFound('Lock')
    const body = z.object({ reason: z.string().trim().min(3).max(500), reasonCode }).parse(req.body)
    const result = await withTransaction((client) => releaseLock(client, req.params.id, req.user!.username, body.reason, body.reasonCode))
    res.json(result)
  }),
)

plansRouter.get(
  '/overrides',
  requireAuth,
  asyncHandler(async (_req, res) => {
    const yard = await readYard(pool)
    const { rows } = await pool.query(`SELECT * FROM overrides WHERE shift_id = $1 ORDER BY created_at DESC LIMIT 100`, [yard.shiftId])
    res.json({
      overrides: rows.map((o) => ({ id: o.id, kind: o.kind, actor: o.actor, reason: o.reason, reasonCode: o.reason_code, before: o.before, after: o.after, violations: o.violations, refused: o.refused, fromVersionNo: o.from_version_no, toVersionNo: o.to_version_no, simAt: o.sim_at, createdAt: o.created_at })),
    })
  }),
)

// ── Solves ──────────────────────────────────────────────────────────────

const solveSchema = z.object({
  algorithm: z.enum(['greedy', 'local_search']).default('local_search'),
  timeLimitMs: z.number().int().min(10).max(60_000).optional(),
  iterationLimit: z.number().int().min(1).max(10_000_000).optional(),
  reason: z.string().max(200).optional(),
  fromScratch: z.boolean().optional(),
})

plansRouter.post(
  '/solves',
  requireRole('yardmaster'),
  asyncHandler(async (req, res) => {
    const body = solveSchema.parse(req.body ?? {})
    const id = await withTransaction(async (client) => {
      const yard = await readYard(client, true)
      const limits = plannerLimits(yard.plannerSettings)
      return enqueueSolve(client, {
        shiftId: yard.shiftId,
        purpose: yard.workingVersionId ? 'replan' : 'initial',
        algorithm: body.algorithm,
        reason: body.reason ?? `requested by ${req.user!.username}`,
        timeLimitMs: body.timeLimitMs ?? limits.timeLimitMs,
        iterationLimit: body.iterationLimit ?? limits.iterations,
        seed: hash32(`manual|${yard.seed}|${yard.stateVersion}|${Date.now()}`) % 2_000_000_000,
        params: { fromScratch: body.fromScratch ?? false },
      })
    })
    res.status(202).json({ id, status: 'queued' })
  }),
)

const jobDto = (j: Record<string, unknown>) => ({
  id: j.id,
  lane: j.lane,
  purpose: j.purpose,
  algorithm: j.algorithm,
  status: j.status,
  reason: j.reason,
  timeLimitMs: j.time_limit_ms,
  iterationLimit: j.iteration_limit,
  stateVersion: j.state_version === null ? null : Number(j.state_version),
  triggerCount: j.trigger_count,
  attempts: j.attempts,
  queuedAt: j.queued_at,
  startedAt: j.started_at,
  finishedAt: j.finished_at,
  resultVersionId: j.result_version_id,
  stats: j.stats,
  error: j.error,
})

plansRouter.get(
  '/solves',
  requireAuth,
  asyncHandler(async (_req, res) => {
    const { rows } = await pool.query(`SELECT id, lane, purpose, algorithm, status, reason, time_limit_ms, iteration_limit, state_version, trigger_count, attempts, queued_at, started_at, finished_at, result_version_id, stats, error FROM solve_jobs ORDER BY queued_at DESC LIMIT 50`)
    res.json({ solves: rows.map(jobDto) })
  }),
)

plansRouter.get(
  '/solves/:id',
  requireAuth,
  asyncHandler(async (req, res) => {
    if (!UUID.test(req.params.id)) throw notFound('Solve')
    const { rows } = await pool.query(`SELECT id, lane, purpose, algorithm, status, reason, time_limit_ms, iteration_limit, state_version, trigger_count, attempts, queued_at, started_at, finished_at, result_version_id, stats, error FROM solve_jobs WHERE id = $1`, [req.params.id])
    if (!rows[0]) throw notFound('Solve')
    res.json({ solve: jobDto(rows[0]) })
  }),
)

plansRouter.post(
  '/replan',
  requireRole('yardmaster'),
  asyncHandler(async (req, res) => {
    const { reason } = z.object({ reason: z.string().max(200).optional() }).parse(req.body ?? {})
    await withTransaction(async (client) => {
      const yard = await readYard(client, true)
      await addTrigger(client, 'manual_replan', { by: req.user!.username, reason: reason ?? null }, yard.stateVersion, yard.shiftId)
    })
    res.status(202).json({ queued: true, coalesceQuietMs: config.planner.coalesceQuietMs })
  }),
)
