import bcrypt from 'bcryptjs'
import request from 'supertest'
import { beforeEach, describe, expect, it, vi } from 'vitest'

type Handler = (sql: string, params: unknown[]) => { rows: unknown[]; rowCount?: number } | undefined
let handler: Handler = () => undefined
const query = vi.fn(async (sql: string, params: unknown[] = []) => handler(sql, params) ?? { rows: [], rowCount: 0 })
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

beforeEach(() => {
  handler = () => undefined
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
    handler = (sql) => (sql.includes('SELECT owner_role, owner_id') ? { rows: [{ owner_role: 'dispatcher', owner_id: 'WEST' }] } : undefined)
    const res = await request(app).post('/api/v1/alerts/a1/acknowledge').set('Cookie', as('bob')).send({ version: 1, action: 'monitor' })
    expect(res.status).toBe(403)
    expect(res.body.error.code).toBe('NOT_OWNER')
  })

  it('lets the owning yard acknowledge its own alert', async () => {
    handler = (sql) => {
      if (sql.includes('SELECT owner_role, owner_id')) return { rows: [{ owner_role: 'yard', owner_id: 'CDJ' }] }
      if (sql.startsWith('UPDATE alerts'))
        return { rows: [{ id: 'a1', trip_id: 't', car_id: 'c', kind: 'hot_bearing', position: 'L1', tier: 2, status: 'acknowledged', version: 2, reasons: [], features: {}, opened_at: new Date(), updated_at: new Date(), yard_id: 'CDJ' }], rowCount: 1 }
      return undefined
    }
    const res = await request(app).post('/api/v1/alerts/a1/acknowledge').set('Cookie', as('bob')).send({ version: 1, action: 'will_inspect_on_arrival' })
    expect(res.status).toBe(200)
    expect(res.body.alert).toMatchObject({ status: 'acknowledged', version: 2 })
  })

  it('keeps thresholds and metrics for reliability engineers', async () => {
    expect((await request(app).get('/api/v1/admin/thresholds').set('Cookie', as('alice'))).status).toBe(403)
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
  it('returns 409 with the current alert when the version is stale (it escalated meanwhile)', async () => {
    handler = (sql) => {
      if (sql.includes('SELECT owner_role, owner_id')) return { rows: [{ owner_role: 'dispatcher', owner_id: 'WEST' }] }
      if (sql.startsWith('UPDATE alerts')) return { rows: [], rowCount: 0 }
      if (sql.includes('WHERE a.id = $1'))
        return { rows: [{ id: 'a1', trip_id: 't', car_id: 'c', kind: 'hot_bearing', position: 'R3', tier: 4, status: 'open', version: 3, reasons: [], features: {}, opened_at: new Date(), updated_at: new Date() }] }
      return undefined
    }
    const res = await request(app).post('/api/v1/alerts/a1/acknowledge').set('Cookie', as('alice')).send({ version: 2, action: 'setout_planned' })
    expect(res.status).toBe(409)
    expect(res.body.error.code).toBe('STALE_ALERT')
    expect(res.body.error.details.alert).toMatchObject({ tier: 4, tierName: 'CRITICAL', version: 3 })
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
  const submit = (body: object, who: keyof typeof users = 'bob') =>
    request(app).post('/api/v1/work-orders/wo1/finding').set('Cookie', as(who)).send({ clientSubmissionId: 'tablet-0001-abcd', ...body })

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

  it('returns the stored finding when the tablet resends the same submission', async () => {
    handler = (sql) =>
      sql.includes('FROM findings WHERE client_submission_id')
        ? { rows: [{ id: 'f1', work_order_id: 'wo1', finding: 'no_defect_found', disposition: 'release', notes: null, recorded_by: 'bob', recorded_at: new Date() }] }
        : undefined
    const res = await submit({ finding: 'no_defect_found', disposition: 'release' })
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ replayed: true, finding: { id: 'f1' } })
    expect(query.mock.calls.some(([sql]) => String(sql).startsWith('INSERT INTO findings'))).toBe(false)
  })

  it('stops an inspector recording a finding for another yard', async () => {
    handler = (sql) => (sql.includes('FROM work_orders WHERE id') ? { rows: [{ id: 'wo1', yard_id: 'RDG', status: 'open', alert_id: 'a1', car_id: 'c', position: 'L1' }] } : undefined)
    expect((await submit({ finding: 'no_defect_found', disposition: 'release' })).status).toBe(403)
  })

  it('closes the work order, alert and hold together on a first submission', async () => {
    handler = (sql) => {
      if (sql.includes('FROM work_orders WHERE id')) return { rows: [{ id: 'wo1', yard_id: 'CDJ', status: 'in_progress', alert_id: 'a1', car_id: 'SVTX 961204', position: 'L1' }] }
      if (sql.startsWith('INSERT INTO findings'))
        return { rows: [{ id: 'f2', work_order_id: 'wo1', finding: 'confirmed_bearing_defect', disposition: 'bad_order', notes: null, recorded_by: 'bob', recorded_at: new Date() }] }
      if (sql.startsWith('UPDATE alerts')) return { rows: [{ id: 'a1', trip_id: 't', desk_id: null, yard_id: 'CDJ', car_id: 'SVTX 961204' }] }
      if (sql.includes('SELECT owner_mark')) return { rows: [{ owner_mark: 'SVTX' }] }
      return undefined
    }
    const res = await submit({ finding: 'confirmed_bearing_defect', disposition: 'bad_order' })
    expect(res.status).toBe(201)
    const sqls = query.mock.calls.map(([sql]) => String(sql))
    expect(sqls.some((s) => s.startsWith('UPDATE work_orders SET status = \'completed\''))).toBe(true)
    const hold = query.mock.calls.find(([sql]) => String(sql).startsWith('UPDATE car_holds'))!
    expect(hold[1]).toContain('bad_ordered')
    // Inspected is not closed: a bad-ordered car's alert stays inspected until the repair is recorded.
    const alert = query.mock.calls.find(([sql]) => String(sql).startsWith('UPDATE alerts'))!
    expect(alert[1]).toContain('inspected')
  })
})

describe('outbound build check', () => {
  it('blocks held and bad-ordered cars and clears the rest', async () => {
    handler = (sql) => (sql.includes('FROM car_holds') ? { rows: [{ car_id: 'SVTX 961204', status: 'active', reason: 'MEDIUM alert', yard_id: 'CDJ' }] } : undefined)
    const res = await request(app).post('/api/v1/yards/CDJ/outbound-check').set('Cookie', as('bob')).send({ carIds: ['svtx  961204', 'NRLX 1'] })
    expect(res.body.blocked).toEqual([{ carId: 'SVTX 961204', status: 'active', reason: 'MEDIUM alert', yardId: 'CDJ' }])
    expect(res.body.clear).toEqual(['NRLX 1'])
  })
})
