import request from 'supertest'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const query = vi.fn()
const sessions = new Map<string, string>()

vi.mock('../shared/db.js', () => ({
  pool: { query: (...args: unknown[]) => query(...args), connect: vi.fn() },
  withTransaction: vi.fn(async (fn: (c: unknown) => unknown) => fn({ query })),
  withSnapshotRead: vi.fn(async (fn: (c: unknown) => unknown) => fn({ query })),
}))
vi.mock('../shared/cache.js', () => ({
  redis: {
    get: vi.fn(async (k: string) => sessions.get(k) ?? null),
    set: vi.fn(async (k: string, v: string) => void sessions.set(k, v)),
    del: vi.fn(async (k: string) => void sessions.delete(k)),
    incr: vi.fn(async () => 1),
    expire: vi.fn(async () => 1),
    ping: vi.fn(async () => 'PONG'),
  },
  keys: { session: (id: string) => `s:${id}`, rate: (b: string) => `r:${b}`, holdStream: 'x', pattern: 'x*' },
  createRedisConnection: vi.fn(),
}))

const { createApp } = await import('./app.js')
const app = createApp()
const asRole = (role: string) => {
  sessions.set('s:tok', JSON.stringify({ id: 'u', username: 'u', displayName: 'U', role }))
  return 'yard_session=tok'
}

describe('api', () => {
  beforeEach(() => {
    query.mockReset()
    sessions.clear()
  })

  it('reports health without auth', async () => {
    expect((await request(app).get('/health')).status).toBe(200)
  })

  it('requires a session for the board', async () => {
    expect((await request(app).get('/api/v1/yard/board')).status).toBe(401)
  })

  it('rejects a bad password', async () => {
    query.mockResolvedValueOnce({ rows: [] })
    const res = await request(app).post('/api/v1/auth/login').send({ username: 'nobody', password: 'x' })
    expect(res.status).toBe(401)
    expect(res.body.error.code).toBe('INVALID_CREDENTIALS')
  })

  it('only a yardmaster can publish or edit', async () => {
    const cookie = asRole('crew')
    const id = '00000000-0000-4000-8000-000000000000'
    expect((await request(app).post(`/api/v1/plans/${id}/publish`).set('Cookie', cookie).send({})).status).toBe(403)
    expect((await request(app).post(`/api/v1/plans/${id}/edits`).set('Cookie', cookie).send({})).status).toBe(403)
  })

  it('needs a reason for an edit', async () => {
    const cookie = asRole('yardmaster')
    const id = '00000000-0000-4000-8000-000000000000'
    const res = await request(app).post(`/api/v1/plans/${id}/edits`).set('Cookie', cookie).send({ expectedVersionNo: 1, ops: [{ op: 'reorder', moveKey: 'm', toIndex: 0 }], reason: '', reasonCode: 'other' })
    expect(res.status).toBe(422)
  })

  it('validates a crew report', async () => {
    const res = await request(app).post('/api/v1/crew/reports').set('Cookie', asRole('crew')).send({ kind: 'start' })
    expect(res.status).toBe(422)
  })

  it('guards integrations with a token', async () => {
    expect((await request(app).post('/api/v1/integrations/clock').send({ now: new Date().toISOString() })).status).toBe(401)
  })

  it('returns 404 for an unknown route and for a malformed id', async () => {
    const cookie = asRole('yardmaster')
    expect((await request(app).get('/api/v1/nope').set('Cookie', cookie)).status).toBe(404)
    expect((await request(app).get('/api/v1/plans/not-a-uuid').set('Cookie', cookie)).status).toBe(404)
  })

  it('reports the simulator being down plainly', async () => {
    // Stubbed so the test doesn't depend on whether a simulator happens to be running locally.
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('connection refused')))
    const res = await request(app).get('/api/v1/sim/state').set('Cookie', asRole('yardmaster'))
    vi.unstubAllGlobals()
    expect(res.status).toBe(503)
    expect(res.body.error.code).toBe('SIMULATOR_DOWN')
  })
})
