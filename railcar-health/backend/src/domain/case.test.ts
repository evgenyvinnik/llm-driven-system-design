import { describe, expect, it } from 'vitest'
import { decideAcknowledge, decideClose, decideEscalate, decideHandOff, decideNotify, decideOpenWorkOrder, decidePlaceHold, decideRaise, decideRecordFinding,
  decideStartWorkOrder, DomainError, evolve, foldCase, initialCase, type CaseEvent, type CaseState } from './case.js'

const T0 = new Date('2026-11-05T12:00:00Z')
const CASE = '11111111-1111-4111-8111-111111111111'
const raiseInput = {
  tripId: 'M-HARRID-1', symbol: 'M-HARRID', carId: 'NRLX 304512', ownerMark: 'NRLX', kind: 'hot_bearing', position: 'R3', tier: 2, action: 'inspect_next_terminal',
  routing: 'yard', deskId: null, territoryId: 'PLN-1', yardId: 'CDJ', owner: { role: 'yard' as const, id: 'CDJ' }, ackDueAt: new Date('2026-11-05T13:00:00Z'),
  reasons: ['steady rise'], features: { sideDelta: 29 }, routeNote: 'Inspect at CDJ', trigger: { detectorId: 'HBD-055', passId: 'P1', passedAt: T0.toISOString(), lagSeconds: 30 },
  late: false, at: T0,
}
const dispatcher = { username: 'alice', role: 'dispatcher' as const, yardId: null }
const inspector = { username: 'bob', role: 'yard' as const, yardId: 'CDJ' }
const otherTablet = { username: 'bob2', role: 'yard' as const, yardId: 'CDJ' }

/** Decides and evolves a sequence of steps, returning the state and every event, as the store would hold them. */
function run(steps: Array<(s: CaseState) => CaseEvent[]>): { state: CaseState; events: CaseEvent[] } {
  let state = initialCase(CASE)
  const events: CaseEvent[] = []
  for (const step of steps) {
    const out = step(state).map((e, i) => ({ ...e, eventId: `ev-${events.length + i + 1}` }))
    events.push(...out)
    state = evolve(state, out)
  }
  return { state, events }
}

const heldMedium = [
  (s: CaseState) => decideRaise(s, raiseInput),
  (s: CaseState) => decidePlaceHold(s, 'CDJ', 'MEDIUM hot bearing', T0),
  (s: CaseState) => decideOpenWorkOrder(s, { caseType: 'alert', tripId: 'M-HARRID-1', carId: 'NRLX 304512', position: 'R3', kind: 'hot_bearing', yardId: 'CDJ', priority: 2, at: T0 }),
  (s: CaseState) => decideNotify(s, { channel: 'yard', target: 'CDJ', kind: 'opened', message: 'MEDIUM', at: T0 }),
]

describe('case aggregate: state is the fold of its events', () => {
  it('rebuilding from the stored events gives the same state as deciding step by step (replay equivalence)', () => {
    const { state, events } = run([...heldMedium, (s) => decideEscalate(s, { ...raiseInput, tier: 3, owner: { role: 'dispatcher', id: 'WEST' }, routing: 'dispatcher_and_yard', reopened: false })])
    const stored = events.map((e, i) => ({ type: e.type, payload: e.payload, streamVersion: i + 1, eventId: e.eventId!, occurredAt: new Date(e.occurredAt).toISOString() }))
    expect(foldCase(CASE, stored)).toEqual(state)
    expect(state).toMatchObject({ tier: 3, status: 'open', owner: { role: 'dispatcher', id: 'WEST' }, yardId: 'CDJ', hold: { status: 'active' }, workOrder: { priority: 3 } })
  })

  it('never de-escalates, and requests each notification once', () => {
    const { state } = run(heldMedium)
    expect(decideEscalate(state, { ...raiseInput, tier: 1, reopened: false })).toEqual([])
    expect(decideNotify(state, { channel: 'yard', target: 'CDJ', kind: 'opened', message: 'again', at: T0 })).toEqual([])
    expect(decidePlaceHold(state, 'CDJ', 'again', T0)).toEqual([])
  })

  it('hands off only to a different owner of the same role', () => {
    const { state } = run([(s) => decideRaise(s, { ...raiseInput, tier: 3, owner: { role: 'dispatcher', id: 'WEST' } })])
    expect(decideHandOff(state, { role: 'dispatcher', id: 'WEST' }, 'desk_territory', null, 'n', T0)).toEqual([])
    expect(decideHandOff(state, { role: 'dispatcher', id: 'EAST' }, 'desk_territory', null, 'n', T0)[0].type).toBe('AlertHandedOff')
  })
})

describe('concurrent case updates: a domain rule, never last-write-wins', () => {
  const ackAt = (s: CaseState, seenVersion: number, actor: { username: string; role: 'dispatcher' | 'yard'; yardId: string | null } = dispatcher) => decideAcknowledge(s, { actor, seenVersion, action: 'setout_planned', note: null, at: T0 })
  const dispatcherOwned = [(s: CaseState) => decideRaise(s, { ...raiseInput, tier: 3, owner: { role: 'dispatcher' as const, id: 'WEST' } })]

  it('rebases an acknowledgment over events that change no decision (notifications, deliveries)', () => {
    const { state } = run([...dispatcherOwned, (s) => decideNotify(s, { channel: 'dispatcher', target: 'WEST', kind: 'opened', message: 'x', at: T0 })])
    expect(ackAt(state, 1)[0]).toMatchObject({ type: 'AlertAcknowledged', payload: { by: 'alice', tier: 3 } })
  })

  it('refuses an acknowledgment of a view the alert has moved past (it escalated meanwhile)', () => {
    const { state } = run([...dispatcherOwned, (s) => decideEscalate(s, { ...raiseInput, tier: 4, owner: { role: 'dispatcher', id: 'WEST' }, reopened: false })])
    expect(() => ackAt(state, 1)).toThrow(expect.objectContaining({ code: 'STALE_ALERT', status: 409, details: { changed: ['AlertEscalated'] } }))
    expect(ackAt(state, 2)).toHaveLength(1)
  })

  it('lets only the owner acknowledge', () => {
    const { state } = run(dispatcherOwned)
    expect(() => ackAt(state, 1, inspector)).toThrow(expect.objectContaining({ code: 'NOT_OWNER', status: 403 }))
  })

  it('treats starting the inspection as the yard owner acknowledging', () => {
    const { state } = run(heldMedium)
    expect(decideStartWorkOrder(state, { actor: inspector, at: T0 }).map((e) => e.type)).toEqual(['WorkOrderStarted', 'AlertAcknowledged'])
    expect(() => decideStartWorkOrder(state, { actor: { ...inspector, yardId: 'RDG' }, at: T0 })).toThrow(DomainError)
  })
})

describe('two offline tablets record different findings for one work order', () => {
  const finding = (clientSubmissionId: string, f: string, disposition: string) => ({ clientSubmissionId, finding: f, disposition, notes: null, observedAt: T0.toISOString(), replacement: null })
  const record = (s: CaseState, actor: typeof inspector, input: ReturnType<typeof finding>) => decideRecordFinding(s, { actor, input, at: T0 })

  it('a repeat of the same submission is a replay, not a second finding', () => {
    const first = run(heldMedium)
    const d = record(first.state, inspector, finding('tablet-A-1', 'no_defect_found', 'release'))
    if (d.kind !== 'recorded') throw new Error('expected recorded')
    const after = evolve(first.state, d.events)
    expect(record(after, inspector, finding('tablet-A-1', 'no_defect_found', 'release'))).toEqual({ kind: 'replayed', findingId: d.findingId })
  })

  it('a defect reported after "no defect" supersedes it: the car is held again and the case reopens as inspected', () => {
    const first = run(heldMedium)
    const a = record(first.state, inspector, finding('tablet-A-1', 'no_defect_found', 'release'))
    if (a.kind !== 'recorded') throw new Error('expected recorded')
    const released = evolve(first.state, a.events)
    expect(released).toMatchObject({ status: 'closed', hold: { status: 'released' } })
    const b = record(released, otherTablet, finding('tablet-B-7', 'confirmed_bearing_defect', 'bad_order'))
    if (b.kind !== 'recorded') throw new Error('expected recorded')
    expect(b.events.map((e) => e.type)).toEqual(['InspectionFindingRecorded', 'CarHoldPlaced'])
    expect(b.events[0].payload).toMatchObject({ supersedesFindingId: a.findingId, source: 'alert' })
    expect(evolve(released, b.events)).toMatchObject({ status: 'inspected', hold: { status: 'bad_ordered' } })
  })

  it('"no defect" reported after a defect is refused: a defect report is never overwritten', () => {
    const first = run(heldMedium)
    const a = record(first.state, inspector, finding('tablet-A-1', 'confirmed_bearing_defect', 'bad_order'))
    if (a.kind !== 'recorded') throw new Error('expected recorded')
    const badOrdered = evolve(first.state, a.events)
    expect(badOrdered).toMatchObject({ status: 'inspected', hold: { status: 'bad_ordered' } })
    expect(() => record(badOrdered, otherTablet, finding('tablet-B-7', 'no_defect_found', 'release'))).toThrow(expect.objectContaining({ code: 'FINDING_CONFLICT' }))
  })

  it('closes a repaired case and releases its hold', () => {
    const first = run(heldMedium)
    const events = decideClose(first.state, { reason: 'repaired', outcome: 'confirmed_bearing_defect', note: 'n', by: 'bob', at: T0 })
    expect(events.map((e) => e.type)).toEqual(['CarHoldReleased', 'CaseClosed'])
    expect(decideClose(evolve(first.state, events), { reason: 'repaired', outcome: 'x', note: 'n', by: 'bob', at: T0 })).toEqual([])
  })
})
