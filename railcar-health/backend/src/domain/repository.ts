/**
 * Write-side repositories. Commands load an aggregate by folding its stream,
 * decide, and stage the new events with the version they loaded as the
 * expected version. The case repository also maintains case_index in the same
 * transaction (one open alert per bearing per trip, one audit per trip, the
 * hold index for outbound checks): set-based invariants an event stream alone
 * can't enforce.
 * @module domain/repository
 */
import type { Queryable } from '../shared/db.js'
import { streamIds } from '../events/catalog.js'
import { readStream, readStreams, type EventBatch } from '../events/store.js'
import { applyCaseEvent, evolve, foldCase, initialCase, type CaseEvent, type CaseState } from './case.js'
import { foldCar, type CarState } from './car.js'

export async function loadCase(db: Queryable, caseId: string): Promise<CaseState> {
  const events = await readStream(db, streamIds.case(caseId))
  return foldCase(caseId, events)
}

export async function loadCases(db: Queryable, caseIds: string[]): Promise<CaseState[]> {
  const events = await readStreams(db, caseIds.map(streamIds.case))
  const byId = new Map(caseIds.map((id) => [id, initialCase(id)]))
  for (const e of events) {
    const id = e.streamId.slice(5)
    byId.set(id, applyCaseEvent(byId.get(id)!, e))
  }
  return caseIds.map((id) => byId.get(id)!)
}

export async function openCaseIds(db: Queryable, filter: { tripId?: string; carId?: string }): Promise<string[]> {
  const { rows } = await db.query<{ case_id: string }>(
    `SELECT case_id FROM case_index WHERE is_open AND ${filter.tripId ? 'trip_id = $1' : 'car_id = $1'} ORDER BY case_id`,
    [filter.tripId ?? filter.carId],
  )
  return rows.map((r) => r.case_id)
}

export async function caseIdForWorkOrder(db: Queryable, workOrderId: string): Promise<string | null> {
  const { rows } = await db.query<{ case_id: string }>('SELECT case_id FROM case_index WHERE work_order_id = $1', [workOrderId]).catch(() => ({ rows: [] }))
  return rows[0]?.case_id ?? null
}

/**
 * Stages events for a case and returns the evolved state. The expected version is the version
 * the state was loaded at; several calls for one case in one batch chain on the first.
 */
export function stageCase(batch: EventBatch, s: CaseState, events: CaseEvent[]): CaseState {
  if (events.length === 0) return s
  const expected = s.version === 0 ? 'no_stream' : s.version
  let state = s
  for (const e of events) {
    const eventId = batch.append(streamIds.case(s.caseId), expected, e)
    state = evolve(state, [{ ...e, eventId }])
  }
  return state
}

/** Upserts the write-side index row for a case (same transaction as its events). */
export async function syncCaseIndex(db: Queryable, s: CaseState): Promise<void> {
  if (!s.exists || !s.carId || !s.tripId) return
  await db.query(
    `INSERT INTO case_index (case_id, case_type, trip_id, car_id, kind, position, is_open, work_order_id, hold_yard_id, hold_status, version, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, now())
     ON CONFLICT (case_id) DO UPDATE SET is_open = EXCLUDED.is_open, work_order_id = EXCLUDED.work_order_id, hold_yard_id = EXCLUDED.hold_yard_id,
       hold_status = EXCLUDED.hold_status, version = EXCLUDED.version, updated_at = now()`,
    [s.caseId, s.caseType, s.tripId, s.carId, s.kind ?? 'audit', s.position ?? 'ALL', s.status !== 'closed', s.workOrder?.workOrderId ?? null,
      s.hold?.yardId ?? null, s.hold?.status ?? null, s.version],
  )
}

export async function loadCar(db: Queryable, carId: string): Promise<CarState> {
  return foldCar(carId, await readStream(db, streamIds.car(carId)))
}

/** Component history for many cars in one query (the analyzer needs every car on the train). */
export async function loadCars(db: Queryable, carIds: string[]): Promise<CarState[]> {
  if (carIds.length === 0) return []
  const events = await readStreams(db, carIds.map(streamIds.car), ['ComponentReplaced'])
  const grouped = new Map<string, typeof events>()
  for (const e of events) {
    const id = e.streamId.slice(4)
    const list = grouped.get(id)
    if (list) list.push(e)
    else grouped.set(id, [e])
  }
  return [...grouped].map(([id, evs]) => foldCar(id, evs))
}

export function stageCar(batch: EventBatch, s: CarState, events: CaseEvent[]): void {
  for (const e of events) batch.append(streamIds.car(s.carId), s.version, e)
}
