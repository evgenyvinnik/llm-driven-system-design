import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PlanMove } from '../domain/types.js'
import { FakeDb } from '../test-support/fake-db.js'

vi.mock('../shared/db.js', () => ({ pool: { query: vi.fn() }, withTransaction: vi.fn(), withSnapshotRead: vi.fn() }))

const { applyCrewReport } = await import('./reports.js')

const T = Date.parse('2026-11-09T08:00:00Z')
const iso = (min: number) => new Date(T + min * 60_000).toISOString()

const cut: PlanMove = { key: 'k1', kind: 'classify', crew: 'hump', carIds: ['c1', 'c2'], fromTrackId: 'R1', toTrackId: 'C1', blockId: 'A', inboundId: 'I1', outboundId: null, plannedStart: T, plannedEnd: T + 6 * 60_000 }
const pull: PlanMove = { key: 'a1', kind: 'assemble', crew: 'trim', carIds: ['c1', 'c2'], fromTrackId: 'C1', toTrackId: 'D1', blockId: 'A', inboundId: null, outboundId: 'O1', plannedStart: T + 6 * 60_000, plannedEnd: T + 13 * 60_000 }

describe('crew reports', () => {
  let db: FakeDb
  const report = (r: Record<string, unknown>, who = 'dave') => applyCrewReport(db as never, { clientReportId: `id-${Math.random().toString(36).slice(2, 12)}`, ...r } as never, who)

  beforeEach(() => {
    db = new FakeDb()
    db.headMoves = [cut, pull]
    db.tracks.set('R1', { kind: 'receiving', capacity_ft: 1000, is_open: true })
    db.tracks.set('C1', { kind: 'classification', capacity_ft: 100, is_open: true })
    db.tracks.set('C2', { kind: 'classification', capacity_ft: 1000, is_open: true })
    db.tracks.set('D1', { kind: 'departure', capacity_ft: 1000, is_open: true })
    for (const id of ['c1', 'c2', 'c3']) db.cars.set(id, { id, position: 'on_track', track_id: 'R1', coupled_to: null, coupled_seq: null, position_as_of: null, length_ft: 50 })
  })

  it('applies a start and a complete, and yard state follows the report', async () => {
    expect((await report({ moveKey: 'k1', kind: 'start', occurredAt: iso(0) })).outcome).toBe('applied')
    expect(db.execs.get('k1')?.status).toBe('in_progress')
    expect(db.cars.get('c1')?.track_id).toBe('R1')
    expect((await report({ moveKey: 'k1', kind: 'complete', occurredAt: iso(5) })).outcome).toBe('applied')
    expect(db.cars.get('c1')?.track_id).toBe('C1')
    expect(db.handlings.has('c1|k1')).toBe(true)
  })

  it('going as planned does not bump the yard state version', async () => {
    const before = db.stateVersion
    await report({ moveKey: 'k1', kind: 'start', occurredAt: iso(0) })
    await report({ moveKey: 'k1', kind: 'complete', occurredAt: iso(5) })
    expect(db.stateVersion).toBe(before)
    expect(db.triggers).toHaveLength(0)
  })

  it('a client id retried returns the first answer and applies nothing twice', async () => {
    const first = await applyCrewReport(db as never, { clientReportId: 'retry-0001', moveKey: 'k1', kind: 'complete', occurredAt: iso(5) }, 'dave')
    db.cars.get('c1')!.track_id = 'MOVED_LATER'
    const again = await applyCrewReport(db as never, { clientReportId: 'retry-0001', moveKey: 'k1', kind: 'complete', occurredAt: iso(5) }, 'dave')
    expect(again.duplicate).toBe(true)
    expect(again.outcome).toBe(first.outcome)
    expect(db.cars.get('c1')?.track_id).toBe('MOVED_LATER')
  })

  it('offline reports synced out of order land the car where in-order ones would', async () => {
    await report({ moveKey: 'a1', kind: 'complete', occurredAt: iso(13), offline: true })
    await report({ moveKey: 'k1', kind: 'complete', occurredAt: iso(5), offline: true })
    expect(db.cars.get('c1')?.track_id).toBe('D1')
    expect(db.cars.get('c1')?.coupled_to).toBe('O1')
    expect(db.handlings.has('c1|k1')).toBe(true)
    expect(db.handlings.has('c1|a1')).toBe(true)
  })

  it('a start that arrives after its complete changes nothing but the time', async () => {
    await report({ moveKey: 'k1', kind: 'complete', occurredAt: iso(5), offline: true })
    const late = await report({ moveKey: 'k1', kind: 'start', occurredAt: iso(0), offline: true })
    expect(late.outcome).toBe('late_noop')
    expect(db.execs.get('k1')?.status).toBe('done')
  })

  it('an offline report queues a replan, because the planner did not know', async () => {
    await report({ moveKey: 'k1', kind: 'complete', occurredAt: iso(5), offline: true })
    expect(db.triggers.map((t) => t.kind)).toEqual(['offline_sync'])
  })

  it('refuses an online start when a car in the move is on hold', async () => {
    db.holds.set('h1', { hold_id: 'h1', car_id: 'c2', status: 'active', stream_version: 1 })
    const out = await report({ moveKey: 'k1', kind: 'start', occurredAt: iso(0) })
    expect(out.outcome).toBe('refused_hold')
    expect(db.execs.has('k1')).toBe(false)
    expect(db.alerts.get('start-refused:k1')).toBe('start_refused_hold')
  })

  it('accepts an offline start on a held car as a fact, and raises an alert', async () => {
    db.holds.set('h1', { hold_id: 'h1', car_id: 'c2', status: 'active', stream_version: 1 })
    const out = await report({ moveKey: 'k1', kind: 'start', occurredAt: iso(0), offline: true })
    expect(out.outcome).toBe('applied')
    expect(db.alerts.get('start-held:k1')).toBe('started_while_held')
  })

  it('alerts when a held car is coupled anyway', async () => {
    db.holds.set('h1', { hold_id: 'h1', car_id: 'c2', status: 'active', stream_version: 1 })
    db.execs.set('a1', { status: 'in_progress', started_at: iso(6), move: pull })
    await report({ moveKey: 'a1', kind: 'complete', occurredAt: iso(13) })
    expect(db.alerts.get('coupled-held:c2')).toBe('hold_after_coupling')
    expect(db.triggers.map((t) => t.kind)).toContain('hold_coupled')
  })

  it('refuses a start when the cars are not on the track yet', async () => {
    const out = await report({ moveKey: 'a1', kind: 'start', occurredAt: iso(6) })
    expect(out.outcome).toBe('refused_not_ready')
  })

  it('a car not found leaves the plan and the state, and replans', async () => {
    db.execs.set('k1', { status: 'in_progress', started_at: iso(0), move: cut })
    const before = db.stateVersion
    const out = await report({ moveKey: 'k1', kind: 'exception', exceptionType: 'car_not_found', carIds: ['c2'], occurredAt: iso(2) })
    expect(out.mismatch).toBe(true)
    expect(db.cars.get('c2')).toMatchObject({ position: 'unknown', track_id: null })
    expect(db.execs.get('k1')?.status).toBe('cancelled')
    expect(db.stateVersion).toBe(before + 1)
    expect(db.triggers.map((t) => t.kind)).toEqual(['crew_exception'])
  })

  it('different cars: the board shows what crews moved, not what the plan said', async () => {
    const out = await report({ moveKey: 'k1', kind: 'exception', exceptionType: 'different_cars', carIds: ['c1', 'c3'], actualToTrackId: 'C2', occurredAt: iso(5) })
    expect(out.mismatch).toBe(true)
    expect(db.cars.get('c3')?.track_id).toBe('C2')
    expect(db.cars.get('c2')?.track_id).toBe('R1')
    expect(db.execs.get('k1')?.move?.carIds).toEqual(['c1', 'c3'])
  })

  it('a blocked track closes the track and replans', async () => {
    const out = await report({ moveKey: 'k1', kind: 'exception', exceptionType: 'track_blocked', trackId: 'C1', occurredAt: iso(1) })
    expect(out.mismatch).toBe(true)
    expect(db.tracks.get('C1')?.is_open).toBe(false)
    expect(db.triggers[0].kind).toBe('crew_exception')
  })

  it('records a capacity violation from what was reported', async () => {
    await report({ moveKey: 'k1', kind: 'exception', exceptionType: 'different_cars', carIds: ['c1', 'c2', 'c3'], occurredAt: iso(5) })
    expect(db.capacityEvents).toHaveLength(1)
    expect(db.alerts.has('capacity:1:C1')).toBe(true)
  })

  it('a late finish beyond the drift limit queues a replan', async () => {
    await report({ moveKey: 'k1', kind: 'complete', occurredAt: iso(45) })
    expect(db.triggers.map((t) => t.kind)).toEqual(['execution_drift'])
  })
})
