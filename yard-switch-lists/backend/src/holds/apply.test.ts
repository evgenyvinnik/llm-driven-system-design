import { beforeEach, describe, expect, it, vi } from 'vitest'
import { FakeDb } from '../test-support/fake-db.js'

vi.mock('../shared/db.js', () => ({ pool: { query: vi.fn() }, withTransaction: vi.fn(), withSnapshotRead: vi.fn() }))

const { applyHoldEvent, makeHoldEvent } = await import('./apply.js')

const at = '2026-11-09T08:00:00.000Z'
const placed = (eventId: string, version = 1, holdId = 'h1', carId = 'c1') => makeHoldEvent({ eventId, type: 'CarHoldPlaced', holdId, carId, caseId: `case${holdId}`, streamVersion: version, occurredAt: at })
const released = (eventId: string, version = 2, holdId = 'h1', carId = 'c1') => makeHoldEvent({ eventId, type: 'CarHoldReleased', holdId, carId, caseId: `case${holdId}`, streamVersion: version, occurredAt: at })

describe('hold consumer', () => {
  let db: FakeDb
  const apply = (e: unknown) => applyHoldEvent(db as never, e, 'test')

  beforeEach(() => {
    db = new FakeDb()
    db.cars.set('c1', { id: 'c1', position: 'on_track', track_id: 'C1', coupled_to: null, coupled_seq: null, position_as_of: null, length_ft: 50 })
  })

  it('a hold removes the car and queues a replan', async () => {
    const before = db.stateVersion
    const out = await apply(placed('e1'))
    expect(out).toMatchObject({ outcome: 'applied', held: true, replanQueued: true })
    expect(db.stateVersion).toBe(before + 1)
    expect(db.triggers.map((t) => t.kind)).toEqual(['hold_placed'])
  })

  it('a duplicate event changes nothing', async () => {
    await apply(placed('e1'))
    const version = db.stateVersion
    const out = await apply(placed('e1'))
    expect(out.outcome).toBe('duplicate')
    expect(db.stateVersion).toBe(version)
    expect(db.triggers).toHaveLength(1)
  })

  it('a release delivered before its hold still ends released', async () => {
    await apply(released('e2', 2))
    const late = await apply(placed('e1', 1))
    expect(late.outcome).toBe('stale')
    expect(late.held).toBe(false)
    expect(db.holds.get('h1')?.status).toBe('released')
  })

  it('in-order and out-of-order delivery land in the same state', async () => {
    const events = [placed('e1', 1), released('e2', 2), placed('e3', 3)]
    for (const e of events) await apply(e)
    const inOrder = db.holds.get('h1')?.status
    db = new FakeDb()
    db.cars.set('c1', { id: 'c1', position: 'on_track', track_id: 'C1', coupled_to: null, coupled_seq: null, position_as_of: null, length_ft: 50 })
    for (const e of [events[2], events[0], events[1]]) await apply(e)
    expect(db.holds.get('h1')?.status).toBe(inOrder)
    expect(inOrder).toBe('active')
  })

  it('a release makes the car eligible again and replans', async () => {
    await apply(placed('e1', 1))
    const out = await apply(released('e2', 2))
    expect(out).toMatchObject({ outcome: 'applied', held: false, replanQueued: true })
    expect(db.triggers.map((t) => t.kind)).toEqual(['hold_placed', 'hold_released'])
  })

  it('a second hold keeps the car held after the first is released', async () => {
    await apply(placed('e1', 1, 'h1'))
    await apply(placed('e2', 1, 'h2'))
    const out = await apply(released('e3', 2, 'h1'))
    expect(out.held).toBe(true)
    expect(out.replanQueued).toBe(false)
  })

  it('a hold after coupling raises an alert for the yardmaster', async () => {
    db.cars.get('c1')!.coupled_to = 'O1'
    db.trains.set('O1', { symbol: 'M-1', status: 'planned' })
    const out = await apply(placed('e1'))
    expect(out.alert).toBe('hold_after_coupling')
    expect(db.alerts.get('hold:h1:coupled')).toBe('hold_after_coupling')
  })

  it('a hold during a move alerts so the crew can be stopped', async () => {
    db.execs.set('m1', { status: 'in_progress', started_at: at, move: { carIds: ['c1'] } as never })
    const out = await apply(placed('e1'))
    expect(out.alert).toBe('hold_during_move')
  })

  it('a hold on a car that already left is an alert, not a replan', async () => {
    db.cars.get('c1')!.position = 'departed'
    const out = await apply(placed('e1'))
    expect(out).toMatchObject({ alert: 'hold_after_departure', replanQueued: false })
  })

  it('ignores another yard', async () => {
    const e = makeHoldEvent({ eventId: 'e9', type: 'CarHoldPlaced', holdId: 'h9', carId: 'c1', caseId: 'x', streamVersion: 1, occurredAt: at, yardId: 'BARSTOW' })
    expect((await apply(e)).outcome).toBe('other_yard')
    expect(db.holds.size).toBe(0)
  })

  it('takes a hold moved to this yard as active', async () => {
    const e = makeHoldEvent({ eventId: 'e7', type: 'CarHoldMoved', holdId: 'h7', carId: 'c1', caseId: 'x', streamVersion: 4, occurredAt: at })
    expect((await apply(e)).held).toBe(true)
  })

  it('keeps a hold for a car it has not seen yet', async () => {
    const out = await apply(placed('e1', 1, 'h5', 'not-here-yet'))
    expect(out.held).toBe(true)
    expect(db.holds.get('h5')?.car_id).toBe('not-here-yet')
  })

  it('records unknown event types without failing', async () => {
    const e = { ...placed('e1'), type: 'AlertRaised' }
    expect((await apply(e)).outcome).toBe('ignored_type')
  })

  it('rejects a malformed envelope', async () => {
    await expect(apply({ type: 'CarHoldPlaced' })).rejects.toThrow()
  })
})
