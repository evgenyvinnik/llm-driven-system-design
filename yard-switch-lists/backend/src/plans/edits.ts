/**
 * Yardmaster edits. An edit never mutates a version: it makes a new draft on top
 * of the working version, or it's refused. The caller names the version number it
 * was looking at, so two yardmasters can't silently overwrite each other: the
 * second gets a 409 with the current version, and the attempt is recorded.
 *
 * The validator decides what's allowed:
 *   - a safety or physical violation is refused, whatever reason is given
 *   - an operating violation needs an explicit override with a reason, which
 *     changes the fact both planner and validator read (a recorded departure
 *     revision, a recorded addition to the standing order, a recorded length
 *     limit). There are no validator exceptions to go stale.
 * @module plans/edits
 */
import type pg from 'pg'
import { HttpError } from '../shared/errors.js'
import { overridesTotal, validatorRuns } from '../shared/metrics.js'
import { applyOps, type EditOp } from '../domain/edit-ops.js'
import type { PlanMove, ValidationResult, Violation, YardSnapshot } from '../domain/types.js'
import { retime, validatePlan } from '../validator/validate.js'
import { readSnapshotWith } from './snapshot.js'
import { bumpState, readYard } from './state.js'
import { insertVersion, loadMoves, loadVersion, type VersionRow } from './versions.js'

export type { EditOp }

export interface EditRequest {
  expectedVersionNo: number
  ops: EditOp[]
  reason: string
  reasonCode: string
  /** The yardmaster has read the operating violations and is overriding them on purpose. */
  overrideSoft?: boolean
}

function splitViolations(result: ValidationResult) {
  return {
    refused: result.violations.filter((v) => v.severity !== 'operating'),
    operating: result.violations.filter((v) => v.severity === 'operating'),
  }
}

/** Carries each operating override into the fact it changes, so nothing has to remember an exception. */
async function applyOperatingOverride(client: pg.PoolClient, snapshot: YardSnapshot, violations: Violation[], result: ValidationResult, moves: PlanMove[]): Promise<Record<string, unknown>[]> {
  const applied: Record<string, unknown>[] = []
  for (const v of violations) {
    if (v.code === 'DEPARTURE_TIME' && v.outboundId) {
      const train = snapshot.outbound.find((t) => t.id === v.outboundId)
      const ready = result.readiness.find((r) => r.outboundId === v.outboundId)?.readyAt
      if (train && ready && ready > train.departure) {
        await client.query(`UPDATE outbound_trains SET revised_departure = $2 WHERE id = $1`, [train.id, new Date(ready).toISOString()])
        train.departure = ready
        applied.push({ code: v.code, train: train.symbol, from: new Date(train.scheduledDeparture).toISOString(), to: new Date(ready).toISOString() })
      }
    } else if (v.code === 'STANDING_ORDER' && v.trackId && v.moveKey) {
      const m = moves.find((x) => x.key === v.moveKey)
      if (m?.blockId) {
        await client.query(`UPDATE blocks SET override_track_ids = array_append(override_track_ids, $2) WHERE id = $1 AND NOT ($2 = ANY(override_track_ids))`, [m.blockId, v.trackId])
        snapshot.blocks.find((b) => b.id === m.blockId)?.alternateTrackIds.push(v.trackId)
        applied.push({ code: v.code, block: m.blockId, track: v.trackId })
      }
    } else if (v.code === 'TRAIN_LENGTH' && v.outboundId && v.overBy) {
      const train = snapshot.outbound.find((t) => t.id === v.outboundId)
      if (train) {
        await client.query(`UPDATE outbound_trains SET max_length_ft = max_length_ft + $2 WHERE id = $1`, [train.id, v.overBy])
        train.maxLengthFt += v.overBy
        applied.push({ code: v.code, train: train.symbol, addedFt: v.overBy })
      }
    }
  }
  return applied
}

export interface EditOutcome {
  version: VersionRow
  validation: ValidationResult
  pinned: { before: string; after: string }[]
}

export async function applyEdit(client: pg.PoolClient, baseId: string, req: EditRequest, by: string): Promise<EditOutcome> {
  const yard = await readYard(client, true)
  const base = await loadVersion(client, baseId)
  if (!base) throw new HttpError(404, 'NOT_FOUND', 'Plan version not found')
  const current = yard.workingVersionId ? await loadVersion(client, yard.workingVersionId) : null
  const beforeMoves = await loadMoves(client, baseId)
  const snapshot = await readSnapshotWith(client)
  const describe = (m: PlanMove | undefined) => (m ? { key: m.key, index: beforeMoves.findIndex((x) => x.key === m.key), toTrackId: m.toTrackId, plannedStart: new Date(m.plannedStart).toISOString() } : null)
  const overrideKind = req.ops.some((o) => o.op === 'retarget') ? 'retarget' : 'reorder'
  const record = async (violations: unknown[], after: unknown, toVersion: number) => {
    await client.query(
      `INSERT INTO overrides (shift_id, kind, actor, reason, reason_code, before, after, violations, refused, from_version_no, to_version_no, sim_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
        yard.shiftId,
        overrideKind,
        by,
        req.reason,
        req.reasonCode,
        JSON.stringify(req.ops.map((o) => describe(beforeMoves.find((m) => m.key === o.moveKey)))),
        JSON.stringify(after),
        JSON.stringify(violations),
        false,
        base.versionNo,
        toVersion,
        yard.simNow.toISOString(),
      ],
    )
    overridesTotal.inc({ kind: overrideKind })
  }

  if (!current || current.id !== baseId || current.versionNo !== req.expectedVersionNo) {
    throw new HttpError(409, 'VERSION_CONFLICT', `The plan moved on: you were editing version ${req.expectedVersionNo}, the working version is ${current?.versionNo ?? 'none'} (by ${current?.authorName ?? 'nobody'}). Your edit wasn't applied.`, {
      expected: req.expectedVersionNo,
      current: current?.versionNo ?? null,
      currentId: current?.id ?? null,
      currentAuthor: current?.authorName ?? null,
    })
  }

  for (const op of req.ops) {
    if (!beforeMoves.some((m) => m.key === op.moveKey)) throw new HttpError(404, 'MOVE_NOT_FOUND', `Move ${op.moveKey} isn't in this version`)
    const exec = snapshot.executions[op.moveKey]
    if (exec && (exec.status === 'done' || exec.status === 'in_progress')) {
      throw new HttpError(422, 'MOVE_FROZEN', `Move ${op.moveKey} has already ${exec.status === 'done' ? 'been done' : 'started'} and can't be edited`)
    }
  }
  const { moves: edited, moved, pins } = applyOps(beforeMoves, req.ops)
  const timed = retime(snapshot, edited, moved)
  let result = validatePlan(snapshot, timed)
  validatorRuns.inc({ author: 'person', result: result.ok ? 'pass' : 'fail' })
  const { refused, operating } = splitViolations(result)
  const afterOps = req.ops.map((o) => describe(timed.find((m) => m.key === o.moveKey)))

  if (refused.length > 0) {
    throw new HttpError(422, 'EDIT_REFUSED', `This edit breaks ${refused.length} rule(s) that can't be overridden: ${refused[0].message}`, { violations: result.violations, overridable: false, afterOps })
  }
  let appliedOverrides: Record<string, unknown>[] = []
  if (operating.length > 0) {
    if (!req.overrideSoft) {
      throw new HttpError(422, 'NEEDS_OVERRIDE', `This edit breaks ${operating.length} operating rule(s). You can override them with a recorded reason.`, { violations: result.violations, overridable: true, afterOps })
    }
    appliedOverrides = await applyOperatingOverride(client, snapshot, operating, result, timed)
    result = validatePlan(snapshot, timed)
    if (!result.ok) {
      throw new HttpError(422, 'EDIT_REFUSED', `The override couldn't clear this edit: ${result.violations[0].message}`, { violations: result.violations, overridable: false })
    }
  }
  const stateVersion = appliedOverrides.length > 0 ? await bumpState(client, 'yardmaster_override', { by, applied: appliedOverrides }, by) : yard.stateVersion
  const version = await insertVersion(client, {
    shiftId: yard.shiftId,
    parentId: baseId,
    authorKind: 'person',
    authorName: by,
    reason: req.reason,
    basedOnStateVersion: stateVersion,
    validation: { ok: result.ok, violations: result.violations, readiness: result.readiness },
    consequences: base.consequences,
    moves: timed,
  })
  await record(operating, { ops: afterOps, overrides: appliedOverrides }, version.versionNo)
  // A drag says "this before that". Pin it, so the next replan can't quietly undo it.
  for (const pin of pins) {
    await client.query(`INSERT INTO locks (shift_id, kind, move_key, before_key, created_by, reason) VALUES ($1, 'sequence', $2, $3, $4, $5)`, [yard.shiftId, pin.before, pin.after, by, req.reason])
  }
  return { version, validation: result, pinned: pins }
}

/** Dry run for the board: what would the validator say about this edit? Writes nothing. */
export async function previewEdit(client: pg.PoolClient, baseId: string, ops: EditOp[]): Promise<ValidationResult> {
  const moves = await loadMoves(client, baseId)
  const snapshot = await readSnapshotWith(client)
  const { moves: edited, moved } = applyOps(moves, ops)
  return validatePlan(snapshot, retime(snapshot, edited, moved))
}

/** Records a refused attempt in its own transaction, after the edit's transaction rolled back. */
export async function recordRefusal(client: pg.PoolClient, versionId: string, req: EditRequest, by: string, code: string, violations: unknown): Promise<void> {
  const yard = await readYard(client)
  const base = await loadVersion(client, versionId)
  await client.query(
    `INSERT INTO overrides (shift_id, kind, actor, reason, reason_code, before, after, violations, refused, from_version_no, sim_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, TRUE, $9, $10)`,
    [yard.shiftId, code === 'VERSION_CONFLICT' ? 'edit_conflict' : 'edit_refused', by, req.reason, req.reasonCode, JSON.stringify({ ops: req.ops }), null, JSON.stringify(violations ?? []), base?.versionNo ?? null, yard.simNow.toISOString()],
  )
  overridesTotal.inc({ kind: code === 'VERSION_CONFLICT' ? 'edit_conflict' : 'edit_refused' })
}
