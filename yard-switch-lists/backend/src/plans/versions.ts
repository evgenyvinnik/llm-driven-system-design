/**
 * Immutable plan versions and the publish step.
 *
 * Publish takes the yard_state row lock, then checks, in order: still a draft;
 * built on the current state version (else 409 and a recompute is queued); still
 * on top of the working version (else 409, someone else's edit got there first);
 * no unresolved lock conflicts; and the validator passes against the state as it
 * is right now, which is the re-check that catches a hold landing after planning.
 * @module plans/versions
 */
import type pg from 'pg'
import type { Queryable } from '../shared/db.js'
import { HttpError } from '../shared/errors.js'
import { publishOutcomes, validatorRuns } from '../shared/metrics.js'
import type { Consequence, LockConflict, PlanMove } from '../domain/types.js'
import { validatePlan } from '../validator/validate.js'
import { readSnapshotWith } from './snapshot.js'
import { addTrigger, readYard, resolveAlert } from './state.js'
import { withTransaction } from '../shared/db.js'

export interface VersionRow {
  id: string
  shiftId: number
  versionNo: number
  status: 'draft' | 'published' | 'superseded'
  parentId: string | null
  authorKind: 'planner' | 'person'
  authorName: string
  reason: string
  basedOnStateVersion: number
  solveId: string | null
  objective: Record<string, unknown>
  validation: { ok?: boolean; violations?: unknown[]; readiness?: unknown[] }
  conflicts: LockConflict[]
  consequences: Consequence[]
  stability: Record<string, unknown> | null
  reviewRequired: boolean
  createdAt: Date
  publishedAt: Date | null
  publishedBy: string | null
  supersededAt: Date | null
}

export function mapVersion(r: Record<string, unknown>): VersionRow {
  return {
    id: r.id as string,
    shiftId: Number(r.shift_id),
    versionNo: Number(r.version_no),
    status: r.status as VersionRow['status'],
    parentId: (r.parent_id as string) ?? null,
    authorKind: r.author_kind as VersionRow['authorKind'],
    authorName: r.author_name as string,
    reason: r.reason as string,
    basedOnStateVersion: Number(r.based_on_state_version),
    solveId: (r.solve_id as string) ?? null,
    objective: (r.objective ?? {}) as Record<string, unknown>,
    validation: (r.validation ?? {}) as VersionRow['validation'],
    conflicts: (r.conflicts ?? []) as LockConflict[],
    consequences: (r.consequences ?? []) as Consequence[],
    stability: (r.stability as Record<string, unknown>) ?? null,
    reviewRequired: Boolean(r.review_required),
    createdAt: r.created_at as Date,
    publishedAt: (r.published_at as Date) ?? null,
    publishedBy: (r.published_by as string) ?? null,
    supersededAt: (r.superseded_at as Date) ?? null,
  }
}

export async function loadVersion(db: Queryable, id: string): Promise<VersionRow | null> {
  const { rows } = await db.query(`SELECT * FROM switch_lists WHERE id = $1`, [id])
  return rows[0] ? mapVersion(rows[0]) : null
}

export async function loadMoves(db: Queryable, listId: string): Promise<PlanMove[]> {
  const { rows } = await db.query(`SELECT * FROM moves WHERE list_id = $1 ORDER BY seq`, [listId])
  return rows.map(
    (m): PlanMove => ({
      key: m.key,
      kind: m.kind,
      crew: m.crew,
      carIds: m.car_ids,
      fromTrackId: m.from_track_id,
      toTrackId: m.to_track_id,
      blockId: m.block_id,
      inboundId: m.inbound_id,
      outboundId: m.outbound_id,
      plannedStart: new Date(m.planned_start).getTime(),
      plannedEnd: new Date(m.planned_end).getTime(),
    }),
  )
}

export interface NewVersion {
  shiftId: number
  parentId: string | null
  authorKind: 'planner' | 'person'
  authorName: string
  reason: string
  basedOnStateVersion: number
  solveId?: string | null
  objective?: unknown
  validation: unknown
  conflicts?: LockConflict[]
  consequences?: Consequence[]
  stability?: unknown
  reviewRequired?: boolean
  moves: PlanMove[]
}

export async function insertVersion(db: Queryable, v: NewVersion): Promise<VersionRow> {
  // Only the working version can be published, so any older draft is dead the moment a new one exists.
  await db.query(`UPDATE switch_lists SET status = 'superseded', superseded_at = now() WHERE shift_id = $1 AND status = 'draft'`, [v.shiftId])
  const { rows: noRows } = await db.query<{ next: number }>(`SELECT COALESCE(MAX(version_no), 0) + 1 AS next FROM switch_lists WHERE shift_id = $1`, [v.shiftId])
  const versionNo = Number(noRows[0].next)
  const { rows } = await db.query(
    `INSERT INTO switch_lists (shift_id, version_no, parent_id, author_kind, author_name, reason, based_on_state_version, solve_id, objective, validation, conflicts, consequences, stability, review_required)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) RETURNING *`,
    [
      v.shiftId,
      versionNo,
      v.parentId,
      v.authorKind,
      v.authorName,
      v.reason,
      v.basedOnStateVersion,
      v.solveId ?? null,
      JSON.stringify(v.objective ?? {}),
      JSON.stringify(v.validation),
      JSON.stringify(v.conflicts ?? []),
      JSON.stringify(v.consequences ?? []),
      v.stability === undefined ? null : JSON.stringify(v.stability),
      v.reviewRequired ?? false,
    ],
  )
  const version = mapVersion(rows[0])
  if (v.moves.length > 0) {
    const n = v.moves.length
    const col = <T>(f: (m: PlanMove, i: number) => T) => v.moves.map(f)
    await db.query(
      `INSERT INTO moves (list_id, seq, key, kind, crew, car_ids, from_track_id, to_track_id, block_id, inbound_id, outbound_id, planned_start, planned_end)
       SELECT $1, u.seq, u.key, u.kind, u.crew, ARRAY(SELECT jsonb_array_elements_text(u.cars)), u.from_track, u.to_track, u.block, u.inbound, u.outbound, u.ps, u.pe
         FROM unnest($2::int[], $3::text[], $4::text[], $5::text[], $6::jsonb[], $7::text[], $8::text[], $9::text[], $10::text[], $11::text[], $12::timestamptz[], $13::timestamptz[])
           AS u(seq, key, kind, crew, cars, from_track, to_track, block, inbound, outbound, ps, pe)`,
      [
        version.id,
        Array.from({ length: n }, (_, i) => i + 1),
        col((m) => m.key),
        col((m) => m.kind),
        col((m) => m.crew),
        col((m) => JSON.stringify(m.carIds)),
        col((m) => m.fromTrackId),
        col((m) => m.toTrackId),
        col((m) => m.blockId),
        col((m) => m.inboundId),
        col((m) => m.outboundId),
        col((m) => new Date(m.plannedStart).toISOString()),
        col((m) => new Date(m.plannedEnd).toISOString()),
      ],
    )
  }
  await db.query(`UPDATE yard_state SET working_version_id = $1, updated_at = now()`, [version.id])
  return version
}

export interface PublishOptions {
  by: string
  /** Who is asking: a person's click can pass the expected working version; auto-publish always builds on the latest. */
  expectedStateVersion?: number
}

export async function publishVersion(client: pg.PoolClient, id: string, opts: PublishOptions): Promise<VersionRow> {
  const yard = await readYard(client, true)
  const version = await loadVersion(client, id)
  if (!version) throw new HttpError(404, 'NOT_FOUND', 'Plan version not found')
  if (version.status === 'published') {
    publishOutcomes.inc({ outcome: 'already_published' })
    return version
  }
  if (version.status !== 'draft') {
    publishOutcomes.inc({ outcome: 'superseded' })
    throw new HttpError(409, 'NOT_DRAFT', `Version ${version.versionNo} is ${version.status} and can't be published`)
  }
  if (version.basedOnStateVersion !== yard.stateVersion || (opts.expectedStateVersion !== undefined && opts.expectedStateVersion !== yard.stateVersion)) {
    publishOutcomes.inc({ outcome: 'stale_state' })
    throw new HttpError(409, 'STALE_STATE', `Version ${version.versionNo} was built on yard state ${version.basedOnStateVersion}, but the yard is at ${yard.stateVersion}. A fresh plan has been queued.`, {
      basedOn: version.basedOnStateVersion,
      current: yard.stateVersion,
      recomputeQueued: true,
    })
  }
  if (yard.workingVersionId !== version.id) {
    publishOutcomes.inc({ outcome: 'head_moved' })
    throw new HttpError(409, 'HEAD_MOVED', `A newer working version exists; version ${version.versionNo} is no longer the latest.`, { workingVersionId: yard.workingVersionId })
  }
  if (version.conflicts.length > 0) {
    publishOutcomes.inc({ outcome: 'conflict' })
    throw new HttpError(409, 'LOCK_CONFLICT', `Version ${version.versionNo} has ${version.conflicts.length} unresolved lock conflict(s). Resolve them before publishing.`, { conflicts: version.conflicts })
  }
  const snapshot = await readSnapshotWith(client)
  const moves = await loadMoves(client, id)
  const result = validatePlan(snapshot, moves)
  validatorRuns.inc({ author: version.authorKind, result: result.ok ? 'pass' : 'fail' })
  if (!result.ok) {
    publishOutcomes.inc({ outcome: 'validation_failed' })
    throw new HttpError(422, 'VALIDATION_FAILED', `Version ${version.versionNo} doesn't pass the validator against the current yard`, { violations: result.violations })
  }
  await client.query(`UPDATE switch_lists SET status = 'superseded', superseded_at = now() WHERE shift_id = $1 AND status = 'published'`, [version.shiftId])
  const { rows } = await client.query(`UPDATE switch_lists SET status = 'published', published_at = now(), published_by = $2 WHERE id = $1 RETURNING *`, [id, opts.by])
  await client.query(`UPDATE yard_state SET head_version_id = $1, updated_at = now()`, [id])
  // Any older draft is dead now: nothing can be built on it any more.
  await client.query(`UPDATE switch_lists SET status = 'superseded', superseded_at = now() WHERE shift_id = $1 AND status = 'draft' AND version_no < $2`, [version.shiftId, version.versionNo])
  await client.query(`UPDATE alerts SET status = 'resolved', resolved_at = now() WHERE kind = 'plan_needs_review' AND status <> 'resolved'`)
  await resolveAlert(client, 'planner:invalid')
  publishOutcomes.inc({ outcome: 'published' })
  return mapVersion(rows[0])
}

/**
 * Publish, and if the plan was built on stale state, queue the recompute. The
 * trigger has to be in its own transaction, or the refusal would roll it back.
 */
export async function publishOrRecompute(id: string, opts: PublishOptions): Promise<VersionRow> {
  try {
    return await withTransaction((client) => publishVersion(client, id, opts))
  } catch (err) {
    if (err instanceof HttpError && err.code === 'STALE_STATE') {
      await withTransaction(async (client) => {
        const yard = await readYard(client, true)
        await addTrigger(client, 'stale_publish', { versionId: id }, yard.stateVersion, yard.shiftId)
      })
    }
    throw err
  }
}
