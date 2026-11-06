import bcrypt from 'bcryptjs'
import request from 'supertest'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createFakeEventStore, type FakeEventStore } from '../events/testing.js'

type Handler = (sql: string, params: unknown[]) => { rows: unknown[]; rowCount?: number } | undefined
let handler: Handler = () => undefined
let store: FakeEventStore = createFakeEventStore()
// Event-store SQL (streams, appends, the case index) goes to the in-memory store; everything else to the test's handler.
const query = vi.fn(async (sql: string, params: unknown[] = []) => store.handle(sql, params) ?? handler(sql, params) ?? { rows: [], rowCount: 0 })
const sessions = new Map<string, string>()

vi.mock('../shared/db.js', () => ({
  pool: { query: (sql: string, params?: unknown[]) => query(sql, params) },
  withTransaction: async (fn: (c: unknown) => Promise<unknown>) => fn({ query: (sql: string, params?: unknown[]) => query(sql, params) }),
}))
vi.mock('../shared/cache.js', () => ({
  redis: {
    get: async (k: string) => sessions.get(k) ?? null,
    set: async (k: string, v: string) => (sessions.set(k, v), 'OK'),
    del: async (k: string) => (sessions.delete(k) ? 1 : 0),
    incr: async () => 1,
    expire: async () => 1,
    ping: async () => 'PONG',
    xadd: async () => '1-0',
    pipeline: () => ({ publish: () => undefined, exec: async () => [] }),
  },
  createRedisConnection: () => ({ subscribe: async () => undefined, on: () => undefined, disconnect: () => undefined }),
}))

const { createApp } = await import('./app.js')
const app = createApp()

const users = {
  alice: { id: 'u1', username: 'alice', displayName: 'Alice', role: 'dispatcher', deskId: 'WEST', yardId: null },
  bob: { id: 'u2', username: 'bob', displayName: 'Bob', role: 'yard', deskId: null, yardId: 'CDJ' },
  carol: { id: 'u3', username: 'carol', displayName: 'Carol', role: 'admin', deskId: null, yardId: null },
}
function as(name: keyof typeof users): string {
  sessions.set(`session:${name}-sid`, JSON.stringify(users[name]))
  return `railcar_session=${name}-sid`
}

const CASE = 'a1a1a1a1-0000-4000-8000-000000000001'
const WO = 'b2b2b2b2-0000-4000-8000-000000000002'
const HOLD = 'c3c3c3c3-0000-4000-8000-000000000003'
const raised = (owner: { role: string; id: string }, tier = 2) => ({
  type: 'AlertRaised',
  payload: {
    caseId: CASE, tripId: 't', symbol: 'Q-HARCDJ', carId: 'SVTX 961204', ownerMark: 'SVTX', kind: 'hot_bearing', position: 'L1', tier, action: 'inspect_next_terminal',
    routing: owner.role === 'yard' ? 'yard' : 'dispatcher_and_yard', deskId: owner.role === 'dispatcher' ? owner.id : null, territoryId: null, yardId: 'CDJ', owner,
    ackDueAt: null, reasons: [], features: {}, routeNote: '', trigger: { detectorId: 'HBD-112', passId: 'P1', passedAt: '2026-11-05T12:00:00Z', lagSeconds: 60 }, late: false,
  },
})
const heldWithWorkOrder = (yardId = 'CDJ') => [
  raised({ role: 'yard', id: yardId }),
  { type: 'CarHoldPlaced', payload: { caseId: CASE, holdId: HOLD, carId: 'SVTX 961204', yardId, reason: 'MEDIUM', status: 'active' } },
  { type: 'WorkOrderOpened', payload: { caseId: CASE, workOrderId: WO, caseType: 'alert', tripId: 't', carId: 'SVTX 961204', position: 'L1', kind: 'hot_bearing', yardId, priority: 2 } },
]
const projectedAlert = (overrides: Record<string, unknown> = {}) => ({
  id: CASE, trip_id: 't', car_id: 'SVTX 961204', kind: 'hot_bearing', position: 'L1', tier: 2, status: 'open', version: 1, reasons: [], features: {},
  opened_at: new Date(), updated_at: new Date(), yard_id: 'CDJ', ...overrides,
})
const appended = () => store.rows.filter((r) => r.actor !== 'test')

beforeEach(() => {
  handler = () => undefined
  store = createFakeEventStore()
  query.mockClear()
})

describe('health and auth', () => {
  it('reports health and the domain clock', async () => {
    expect((await request(app).get('/health')).body).toEqual({ status: 'ok' })
    const clock = await request(app).get('/api/v1/clock')
    expect(clock.body).toMatchObject({ simulated: false, speed: 1 })
  })

  it('signs in with a correct password and rejects a wrong one', async () => {
    const hash = await bcrypt.hash('password123', 4)
    handler = (sql) => (sql.includes('FROM users') ? { rows: [{ id: 'u1', username: 'alice', display_name: 'Alice', role: 'dispatcher', desk_id: 'WEST', yard_id: null, password_hash: hash }] } : undefined)
    const ok = await request(app).post('/api/v1/auth/login').send({ username: 'alice', password: 'password123' })
    expect(ok.status).toBe(200)
    expect(ok.body.user).toMatchObject({ username: 'alice', role: 'dispatcher', deskId: 'WEST' })
    expect(ok.headers['set-cookie'][0]).toMatch(/railcar_session=/)
    const bad = await request(app).post('/api/v1/auth/login').send({ username: 'alice', password: 'nope' })
    expect(bad.status).toBe(401)
  })

  it('requires a session for read APIs', async () => {
    expect((await request(app).get('/api/v1/alerts')).status).toBe(401)
  })
})

describe('role checks', () => {
  it('lets only the alert’s owner acknowledge it: a yard cannot acknowledge a dispatcher’s alert', async () => {
    store.seed(`case-${CASE}`, [raised({ role: 'dispatcher', id: 'WEST' }, 3)])
    const res = await request(app).post(`/api/v1/alerts/${CASE}/acknowledge`).set('Cookie', as('bob')).send({ version: 1, action: 'monitor' })
    expect(res.status).toBe(403)
    expect(res.body.error.code).toBe('NOT_OWNER')
    expect(appended()).toHaveLength(0)
  })

  it('lets the owning yard acknowledge its own alert, rebasing over a notification it had not seen', async () => {
    store.seed(`case-${CASE}`, [
      raised({ role: 'yard', id: 'CDJ' }),
      { type: 'NotificationRequested', payload: { caseId: CASE, notificationId: 'd4d4d4d4-0000-4000-8000-000000000004', channel: 'yard', target: 'CDJ', kind: 'opened', message: 'm' } },
    ])
    handler = (sql) => (sql.includes('WHERE a.id = $1') ? { rows: [projectedAlert()] } : undefined)
    const res = await request(app).post(`/api/v1/alerts/${CASE}/acknowledge`).set('Cookie', as('bob')).send({ version: 1, action: 'will_inspect_on_arrival' })
    expect(res.status).toBe(200)
    // Answered from the aggregate, not the (possibly stale) projection.
    expect(res.body).toMatchObject({ rebasedOver: 1, alert: { status: 'acknowledged', version: 3, acknowledgedBy: 'bob' } })
    expect(appended().map((r) => [r.type, r.stream_version])).toEqual([['AlertAcknowledged', 3]])
  })

  it('keeps thresholds and metrics for reliability engineers', async () => {
    expect((await request(app).get('/api/v1/admin/thresholds').set('Cookie', as('alice'))).status).toBe(403)
  })

  it('keeps the Ops / Streams page and dead-letter redrive for reliability engineers', async () => {
    expect((await request(app).get('/api/v1/ops/streams').set('Cookie', as('alice'))).status).toBe(403)
    expect((await request(app).post('/api/v1/ops/dlq/1-0/redrive').set('Cookie', as('bob'))).status).toBe(403)
  })

  it('stops a yard inspector reading another yard', async () => {
    expect((await request(app).get('/api/v1/yards/RDG/work-orders').set('Cookie', as('bob'))).status).toBe(403)
  })

  it('scopes the alert list to the inspector’s own yard', async () => {
    handler = (sql) => (sql.includes('FROM alerts') ? { rows: [] } : undefined)
    await request(app).get('/api/v1/alerts').set('Cookie', as('bob'))
    const listCall = query.mock.calls.find(([sql]) => String(sql).includes('ORDER BY'))!
    expect(String(listCall[0])).toContain('a.yard_id = $')
    expect(listCall[1]).toContain('CDJ')
  })
})

describe('acknowledging an alert', () => {
  it('returns 409 with the current alert when a decision changed since the version the dispatcher saw (it escalated)', async () => {
    store.seed(`case-${CASE}`, [
      raised({ role: 'dispatcher', id: 'WEST' }, 3),
      { type: 'AlertEscalated', payload: { ...raised({ role: 'dispatcher', id: 'WEST' }).payload, tripId: undefined, fromTier: 3, toTier: 4, reopened: false } },
    ])
    handler = (sql) => (sql.includes('WHERE a.id = $1') ? { rows: [projectedAlert({ tier: 4, version: 2, owner_role: 'dispatcher', owner_id: 'WEST' })] } : undefined)
    const res = await request(app).post(`/api/v1/alerts/${CASE}/acknowledge`).set('Cookie', as('alice')).send({ version: 1, action: 'setout_planned' })
    expect(res.status).toBe(409)
    expect(res.body.error.code).toBe('STALE_ALERT')
    expect(res.body.error.details).toMatchObject({ changed: ['AlertEscalated'], alert: { tier: 4, tierName: 'CRITICAL', version: 2 } })
    expect(appended()).toHaveLength(0)
  })
})

describe('ingest endpoints', () => {
  it('require the gateway token and validate the batch', async () => {
    expect((await request(app).post('/api/v1/ingest/passes').send({})).status).toBe(401)
    const res = await request(app).post('/api/v1/ingest/passes').set('X-Ingest-Token', 'local-dev-ingest-token').send({ gatewayId: 'GW', passes: [] })
    expect(res.status).toBe(422)
    expect(res.body.error.code).toBe('VALIDATION_FAILED')
  })
})

describe('inspection findings', () => {
  const submit = (body: object, who: keyof typeof users = 'bob', id = 'tablet-0001-abcd') =>
    request(app).post(`/api/v1/work-orders/${WO}/finding`).set('Cookie', as(who)).send({ clientSubmissionId: id, ...body })
  const indexCase = () => store.caseIndex.set(CASE, { case_id: CASE, work_order_id: WO })

  it('refuses to release a car with a confirmed defect', async () => {
    const res = await submit({ finding: 'confirmed_bearing_defect', disposition: 'release' })
    expect(res.status).toBe(422)
    expect(res.body.error.details[0].path).toBe('disposition')
  })

  it('requires the replacement wheelset when the car is repaired on the spot', async () => {
    const res = await submit({ finding: 'confirmed_bearing_defect', disposition: 'repaired' })
    expect(res.status).toBe(422)
    expect(res.body.error.details[0].path).toBe('replacement')
  })

  it('returns the stored finding when the tablet resends the same submission, appending nothing', async () => {
    store.seed(`case-${CASE}`, [
      ...heldWithWorkOrder(),
      { type: 'InspectionFindingRecorded', payload: { caseId: CASE, findingId: 'f1f1f1f1-0000-4000-8000-000000000005', workOrderId: WO, clientSubmissionId: 'tablet-0001-abcd', carId: 'SVTX 961204', position: 'L1', finding: 'no_defect_found', disposition: 'release', notes: null, recordedBy: 'bob', observedAt: '2026-11-05T12:00:00Z', replacement: null, source: 'alert', supersedesFindingId: null } },
    ])
    indexCase()
    const res = await submit({ finding: 'no_defect_found', disposition: 'release' })
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ replayed: true, finding: { id: 'f1f1f1f1-0000-4000-8000-000000000005' } })
    expect(appended()).toHaveLength(0)
  })

  it('stops an inspector recording a finding for another yard', async () => {
    store.seed(`case-${CASE}`, heldWithWorkOrder('RDG'))
    indexCase()
    expect((await submit({ finding: 'no_defect_found', disposition: 'release' })).status).toBe(403)
  })

  it('records a bad-order finding on the case stream: inspected, not closed, hold bad-ordered', async () => {
    store.seed(`case-${CASE}`, heldWithWorkOrder())
    indexCase()
    const res = await submit({ finding: 'confirmed_bearing_defect', disposition: 'bad_order' })
    expect(res.status).toBe(201)
    expect(appended().map((r) => r.type)).toEqual(['InspectionFindingRecorded'])
    expect(appended()[0].payload).toMatchObject({ source: 'alert', disposition: 'bad_order', workOrderId: WO })
    expect(store.caseIndex.get(CASE)).toMatchObject({ is_open: true, hold_status: 'bad_ordered' })
  })

  it('closes the case and releases the hold together when the car is released', async () => {
    store.seed(`case-${CASE}`, heldWithWorkOrder())
    indexCase()
    const res = await submit({ finding: 'no_defect_found', disposition: 'release' })
    expect(res.status).toBe(201)
    expect(appended().map((r) => r.type)).toEqual(['InspectionFindingRecorded', 'CarHoldReleased', 'CaseClosed'])
    expect(store.caseIndex.get(CASE)).toMatchObject({ is_open: false, hold_status: 'released' })
  })

  it('lets a later defect report from a second tablet supersede a "no defect" one (most severe wins)', async () => {
    store.seed(`case-${CASE}`, heldWithWorkOrder())
    indexCase()
    expect((await submit({ finding: 'no_defect_found', disposition: 'release' }, 'bob', 'tablet-A-0001')).status).toBe(201)
    const second = await submit({ finding: 'confirmed_bearing_defect', disposition: 'bad_order' }, 'bob', 'tablet-B-0002')
    expect(second.status).toBe(201)
    expect(second.body.superseded).toBe(true)
    const third = await submit({ finding: 'no_defect_found', disposition: 'release' }, 'bob', 'tablet-C-0003')
    expect(third.status).toBe(409)
    expect(third.body.error.code).toBe('FINDING_CONFLICT')
  })
})

describe('outbound build check', () => {
  it('blocks held and bad-ordered cars from the write-side hold index, and clears the rest', async () => {
    handler = (sql) => (sql.includes('FROM case_index') ? { rows: [{ car_id: 'SVTX 961204', status: 'active', yard_id: 'CDJ', kind: 'hot_bearing', position: 'L1' }] } : undefined)
    const res = await request(app).post('/api/v1/yards/CDJ/outbound-check').set('Cookie', as('bob')).send({ carIds: ['svtx  961204', 'NRLX 1'] })
    expect(res.body.blocked).toEqual([{ carId: 'SVTX 961204', status: 'active', yardId: 'CDJ', reason: 'Held for hot bearing L1: inspect before building into an outbound train' }])
    expect(res.body.clear).toEqual(['NRLX 1'])
    expect(query.mock.calls.some(([sql]) => String(sql).includes('FROM car_holds'))).toBe(false)
  })
})
