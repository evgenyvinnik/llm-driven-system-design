import bcrypt from 'bcryptjs'
import request from 'supertest'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// ── Mock shared modules before importing the app ───────────────────────────
const store = new Map<string, string>()
const xadds: { stream: string; reading: { locomotiveId: string; seq: number } }[] = []

const fakeRedis = {
  get: vi.fn(async (k: string) => store.get(k) ?? null),
  set: vi.fn(async (k: string, v: string) => {
    store.set(k, v)
    return 'OK'
  }),
  del: vi.fn(async (k: string) => Number(store.delete(k))),
  exists: vi.fn(async (k: string) => (store.has(k) ? 1 : 0)),
  incr: vi.fn(async () => 1),
  expire: vi.fn(async () => 1),
  publish: vi.fn(async () => 0),
  xadd: vi.fn(async () => '1-0'),
  ping: vi.fn(async () => 'PONG'),
  hgetall: vi.fn(async () => ({})),
  pipeline: vi.fn(() => {
    const ops: unknown[] = []
    const pipe = {
      xadd: (stream: string, ...args: string[]) => {
        xadds.push({ stream, reading: JSON.parse(args[args.length - 1]) })
        ops.push(1)
        return pipe
      },
      hgetall: () => {
        ops.push(1)
        return pipe
      },
      exec: async () => ops.map(() => [null, {}]),
    }
    return pipe
  }),
}

vi.mock('../shared/cache.js', () => ({
  redis: fakeRedis,
  createRedisConnection: () => ({ subscribe: vi.fn(), on: vi.fn(), disconnect: vi.fn() }),
  keys: {
    session: (id: string) => `lf:session:${id}`,
    batchSeen: (id: string) => `lf:ingest:batch:${id}`,
    telemetryStream: (p: number) => `lf:telemetry:p${p}`,
    locoState: (id: string) => `lf:loco:${id}:state`,
    planRequests: 'lf:plan:requests',
    planPending: (id: string) => `lf:plan:pending:${id}`,
    simClock: 'lf:sim:clock',
    events: 'lf:events',
    rate: (b: string) => `lf:rate:${b}`,
  },
}))

let passwordHash = ''
let ticketInsertRowCount = 1
const query = vi.fn(async (sql: string, _args?: unknown[]) => {
  if (sql.includes('FROM users WHERE username')) {
    return { rows: [{ id: 'u_alice', username: 'alice', display_name: 'Alice Romero', role: 'fuel_desk', train_id: null, password_hash: passwordHash }], rowCount: 1 }
  }
  if (sql.includes('INSERT INTO fuel_tickets')) return { rows: [], rowCount: ticketInsertRowCount }
  return { rows: [], rowCount: 0 }
})
vi.mock('../shared/db.js', () => ({
  pool: { query },
  withTransaction: async (fn: (db: { query: typeof query }) => Promise<unknown>) => fn({ query }),
}))

const { createApp } = await import('./app.js')
const app = createApp()

async function sessionCookie(user: Record<string, unknown>): Promise<string> {
  const id = `test-${Math.random().toString(36).slice(2)}`
  store.set(`lf:session:${id}`, JSON.stringify(user))
  return `fueling_session=${id}`
}

const reading = (locomotiveId: string, seq: number) => ({
  locomotiveId,
  seq,
  recordedAt: seq * 1000,
  lat: 35,
  lon: -101,
  milepost: 500,
  speedMph: 45,
  notch: 5,
  fuelGal: 3200,
  engineState: 'run',
})

beforeAll(async () => {
  passwordHash = await bcrypt.hash('password123', 4)
})

beforeEach(() => {
  xadds.length = 0
  ticketInsertRowCount = 1
})

describe('health', () => {
  it('reports ok', async () => {
    expect((await request(app).get('/health')).body).toEqual({ status: 'ok' })
  })
})

describe('auth and roles', () => {
  it('rejects a wrong password and signs in with the right one', async () => {
    expect((await request(app).post('/api/v1/auth/login').send({ username: 'alice', password: 'nope' })).status).toBe(401)
    const ok = await request(app).post('/api/v1/auth/login').send({ username: 'alice', password: 'password123' })
    expect(ok.status).toBe(200)
    expect(ok.body.user).toMatchObject({ username: 'alice', role: 'fuel_desk' })
    expect(ok.headers['set-cookie'][0]).toContain('fueling_session=')
  })

  it('requires a session for the fleet board', async () => {
    expect((await request(app).get('/api/v1/fleet')).status).toBe(401)
  })

  it('keeps crew on their own train, including plan acceptance', async () => {
    const cookie = await sessionCookie({ id: 'u_bob', username: 'bob', displayName: 'Bob', role: 'crew', trainId: 'T03' })
    const other = await request(app).get('/api/v1/trains/T01').set('Cookie', cookie)
    expect(other.status).toBe(403)
    const accept = await request(app).post('/api/v1/trains/T01/plans/2/accept').set('Cookie', cookie)
    expect(accept.status).toBe(403)
    // Crew can't confirm proposals or touch orders at all.
    expect((await request(app).post('/api/v1/trains/T03/plans/2/confirm').set('Cookie', cookie)).status).toBe(403)
    expect((await request(app).get('/api/v1/orders').set('Cookie', cookie)).status).toBe(403)
  })

  it('lets only admins change prices and parameters', async () => {
    const desk = await sessionCookie({ id: 'u_alice', username: 'alice', displayName: 'Alice', role: 'fuel_desk', trainId: null })
    expect((await request(app).put('/api/v1/admin/fuel-options/AMA-PAD').set('Cookie', desk).send({ pricePerGal: 2.4 })).status).toBe(403)
    expect((await request(app).put('/api/v1/admin/params').set('Cookie', desk).send({ reservePct: 0.2 })).status).toBe(403)
    const admin = await sessionCookie({ id: 'u_carol', username: 'carol', displayName: 'Carol', role: 'admin', trainId: null })
    const bad = await request(app).put('/api/v1/admin/params').set('Cookie', admin).send({ reservePct: 5 })
    expect(bad.status).toBe(422)
  })
})

describe('telemetry ingest', () => {
  const url = '/api/v1/telemetry/batch'
  const token = { 'X-Device-Token': 'local-device-token' }

  it('requires the device token', async () => {
    expect((await request(app).post(url).send({ batchId: 'batch-0001', readings: [reading('6012', 1)] })).status).toBe(401)
  })

  it('validates the batch', async () => {
    const res = await request(app).post(url).set(token).send({ batchId: 'batch-0002', readings: [{ ...reading('6012', 1), notch: 12 }] })
    expect(res.status).toBe(422)
    expect(res.body.error.code).toBe('VALIDATION_FAILED')
  })

  it('drops in-batch repeats, orders each locomotive by seq, and routes by locomotive', async () => {
    const res = await request(app)
      .post(url)
      .set(token)
      .send({ batchId: 'batch-0003', readings: [reading('6012', 3), reading('6013', 1), reading('6012', 1), reading('6012', 3), reading('6012', 2)] })
    expect(res.status).toBe(202)
    expect(res.body).toEqual({ accepted: 4, duplicate: false })
    const seqs6012 = xadds.filter((x) => x.reading.locomotiveId === '6012').map((x) => x.reading.seq)
    expect(seqs6012).toEqual([1, 2, 3])
    // One partition per locomotive: every 6012 reading went to the same stream.
    expect(new Set(xadds.filter((x) => x.reading.locomotiveId === '6012').map((x) => x.stream)).size).toBe(1)
  })

  it('answers a replayed batch id as a duplicate without appending again', async () => {
    const body = { batchId: 'batch-0004', readings: [reading('6012', 10)] }
    expect((await request(app).post(url).set(token).send(body)).status).toBe(202)
    const before = xadds.length
    const again = await request(app).post(url).set(token).send(body)
    expect(again.status).toBe(200)
    expect(again.body).toEqual({ accepted: 0, duplicate: true })
    expect(xadds.length).toBe(before)
  })
})

describe('fuel ticket webhook', () => {
  const ticket = {
    ticketId: 'VT-DTL-1001',
    source: 'vendor',
    vendorOrderId: 'DTL-1001',
    stopKey: 'T01:GAL:GAL-DTL',
    trainId: 'T01',
    locationId: 'GAL',
    optionId: 'GAL-DTL',
    deliveredAt: '2026-11-05T12:00:00Z',
    pricePerGal: 2.97,
    perUnit: [{ locomotiveId: '6012', gallons: 2100 }],
  }
  const token = { 'X-Integration-Token': 'local-integration-token' }

  it('records a new ticket and treats a redelivery as a duplicate', async () => {
    expect((await request(app).post('/api/v1/integrations/fuel-tickets').set(token).send(ticket)).status).toBe(201)
    ticketInsertRowCount = 0
    const again = await request(app).post('/api/v1/integrations/fuel-tickets').set(token).send(ticket)
    expect(again.status).toBe(200)
    expect(again.body.duplicate).toBe(true)
  })

  it('rejects calls without the integration token', async () => {
    expect((await request(app).post('/api/v1/integrations/fuel-tickets').send(ticket)).status).toBe(401)
  })
})
