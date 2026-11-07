/**
 * HTTP contract of the API with the database and Valkey mocked: auth,
 * idempotency-key enforcement, validation and workspace scoping in queries.
 */
import request from 'supertest'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const sessions = new Map<string, string>()
const query = vi.fn()

vi.mock('../shared/cache.js', () => ({
  redis: {
    get: vi.fn(async (k: string) => sessions.get(k) ?? null),
    set: vi.fn(async (k: string, v: string) => sessions.set(k, v)),
    del: vi.fn(async (k: string) => sessions.delete(k)),
    incr: vi.fn(async () => 1),
    expire: vi.fn(async () => 1),
    ping: vi.fn(async () => 'PONG'),
  },
  keys: { session: (id: string) => `evals:session:${id}`, rate: (b: string) => `evals:rate:${b}` },
}))
vi.mock('../shared/db.js', () => ({
  pool: { query: (...args: unknown[]) => query(...args), connect: vi.fn() },
  withTransaction: vi.fn(),
}))

const { createApp } = await import('./app.js')
const app = createApp()

const alice = { id: 'usr_alice', username: 'alice', displayName: 'Alice', workspaceId: 'ws_acme', workspaceName: 'Acme AI' }
function signedIn() {
  sessions.set('evals:session:test-session', JSON.stringify(alice))
  return 'evals_session=test-session'
}

beforeEach(() => {
  query.mockReset()
  sessions.clear()
})

describe('API', () => {
  it('health is public; everything else needs a session', async () => {
    expect((await request(app).get('/health')).status).toBe(200)
    const res = await request(app).get('/api/v1/runs')
    expect(res.status).toBe(401)
    expect(res.body.error.code).toBe('UNAUTHENTICATED')
  })

  it('run creation requires an Idempotency-Key', async () => {
    const res = await request(app).post('/api/v1/runs').set('Cookie', signedIn()).send({})
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('IDEMPOTENCY_KEY_REQUIRED')
  })

  it('run creation validates the body before touching the database', async () => {
    const res = await request(app).post('/api/v1/runs').set('Cookie', signedIn()).set('Idempotency-Key', 'k1').send({ datasetVersionId: 'x', samplesPerCase: 50 })
    expect(res.status).toBe(422)
    expect(res.body.error.code).toBe('VALIDATION_FAILED')
    expect(query).not.toHaveBeenCalled()
  })

  it('reading a run is scoped to the caller workspace (another workspace gets 404)', async () => {
    query.mockResolvedValue({ rows: [] })
    const res = await request(app).get('/api/v1/runs/run_globex').set('Cookie', signedIn())
    expect(res.status).toBe(404)
    const [sql, params] = query.mock.calls[0] as [string, unknown[]]
    expect(sql).toContain('r.workspace_id = $2')
    expect(params).toEqual(['run_globex', 'ws_acme'])
  })

  it('compare needs both runs and a scorer', async () => {
    const res = await request(app).get('/api/v1/compare?a=run_a').set('Cookie', signedIn())
    expect(res.status).toBe(422)
  })

  it('annotation labels are validated', async () => {
    const res = await request(app).put('/api/v1/runs/run_a/annotations/cr_1').set('Cookie', signedIn()).send({ label: 'maybe' })
    expect(res.status).toBe(422)
  })

  it('logout clears the session', async () => {
    const cookie = signedIn()
    expect((await request(app).post('/api/v1/auth/logout').set('Cookie', cookie)).status).toBe(204)
    expect((await request(app).get('/api/v1/auth/me').set('Cookie', cookie)).status).toBe(401)
  })
})
