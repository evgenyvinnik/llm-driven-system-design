/**
 * API tests with the shared PostgreSQL and Valkey modules mocked (repo pattern):
 * authentication, role checks, owner scoping inside queries, idempotent
 * campaign creation, the exception approval rules and the deny-policy guardrail.
 */
import bcrypt from 'bcryptjs'
import request from 'supertest'
import { beforeEach, describe, expect, it, vi } from 'vitest'

type Route = [string, (sql: string, params: unknown[]) => { rows: unknown[]; rowCount?: number }]

const mocks = vi.hoisted(() => {
  const state = { routes: [] as Route[], calls: [] as { sql: string; params: unknown[] }[], sessions: new Map<string, string>() }
  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    state.calls.push({ sql, params })
    for (const [pattern, handler] of state.routes) if (sql.includes(pattern)) return { rowCount: 0, ...handler(sql, params) }
    return { rows: [], rowCount: 0 }
  })
  const redis = {
    get: vi.fn(async (key: string) => state.sessions.get(key) ?? null),
    set: vi.fn(async () => 'OK'),
    del: vi.fn(async () => 1),
    incr: vi.fn(async () => 1),
    expire: vi.fn(async () => 1),
    ping: vi.fn(async () => 'PONG'),
    publish: vi.fn(async () => 1),
    xrevrange: vi.fn(async () => []),
  }
  return { state, query, redis }
})

vi.mock('../shared/db.js', () => ({
  pool: { query: mocks.query },
  withTransaction: async (fn: (c: { query: typeof mocks.query }) => unknown) => fn({ query: mocks.query }),
}))
vi.mock('../shared/cache.js', () => ({ redis: mocks.redis, createRedisConnection: () => mocks.redis }))

const { createApp } = await import('./app.js')

const USERS = {
  alice: { id: 'u_alice', username: 'alice', displayName: 'Alice Chen', role: 'security', team: null },
  bob: { id: 'u_bob', username: 'bob', displayName: 'Bob Ortiz', role: 'owner', team: 'payments' },
  carol: { id: 'u_carol', username: 'carol', displayName: 'Carol Davis', role: 'approver', team: null },
}

function as(user: keyof typeof USERS) {
  mocks.state.sessions.set(`session:${user}-session`, JSON.stringify(USERS[user]))
  return `remediation_session=${user}-session`
}

const app = createApp()

beforeEach(() => {
  mocks.state.routes = []
  mocks.state.calls = []
  mocks.state.sessions.clear()
})

describe('health and auth', () => {
  it('reports health without a session', async () => {
    expect((await request(app).get('/health')).body).toEqual({ status: 'ok' })
  })

  it('rejects unauthenticated requests', async () => {
    const res = await request(app).get('/api/v1/posture')
    expect(res.status).toBe(401)
    expect(res.body.error.code).toBe('UNAUTHENTICATED')
  })

  it('logs in with the right password and sets an httpOnly session cookie', async () => {
    const hash = await bcrypt.hash('password123', 4)
    mocks.state.routes.push(['FROM users WHERE username', () => ({ rows: [{ id: 'u_bob', username: 'bob', display_name: 'Bob Ortiz', role: 'owner', team: 'payments', password_hash: hash }] })])
    const bad = await request(app).post('/api/v1/auth/login').send({ username: 'bob', password: 'nope' })
    expect(bad.status).toBe(401)
    const ok = await request(app).post('/api/v1/auth/login').send({ username: 'BOB', password: 'password123' })
    expect(ok.status).toBe(200)
    expect(ok.body.user).toMatchObject({ username: 'bob', role: 'owner', team: 'payments' })
    expect(ok.headers['set-cookie'][0]).toMatch(/remediation_session=.+HttpOnly/)
  })
})

describe('authorization and scoping', () => {
  it('only lets security engineers create campaigns', async () => {
    const res = await request(app).post('/api/v1/campaigns').set('Cookie', as('bob')).send({ name: 'x', controlId: 'SA-02' })
    expect(res.status).toBe(403)
  })

  it('validates campaign input', async () => {
    const res = await request(app).post('/api/v1/campaigns').set('Cookie', as('alice')).send({ name: 'ok name', controlId: 'SA-02', bakeSeconds: 1 })
    expect(res.status).toBe(422)
    expect(res.body.error.details[0].path).toBe('bakeSeconds')
  })

  it('filters findings by the owner team inside the SQL, not after it', async () => {
    mocks.state.routes.push(['count(*)::int AS n FROM findings', () => ({ rows: [{ n: 0 }] })])
    const res = await request(app).get('/api/v1/findings?control=SA-02').set('Cookie', as('bob'))
    expect(res.status).toBe(200)
    const listing = mocks.state.calls.find((c) => c.sql.includes('FROM findings f JOIN storage_accounts a') && c.sql.includes('LIMIT'))!
    expect(listing.sql).toContain('a.owner = $1')
    expect(listing.params[0]).toBe('payments')
  })

  it("refuses an owner access to another team's account", async () => {
    mocks.state.routes.push(['FROM storage_accounts a\n       LEFT JOIN subscriptions', () => ({ rows: [{ id: '/subscriptions/s/resourceGroups/r/providers/Microsoft.Storage/storageAccounts/stother', name: 'stother', owner: 'identity' }] })])
    const res = await request(app).get('/api/v1/accounts/stother').set('Cookie', as('bob'))
    expect(res.status).toBe(403)
    expect(res.body.error.code).toBe('NOT_YOUR_ACCOUNT')
  })
})

describe('campaign idempotency and lifecycle', () => {
  it('returns the existing campaign for a repeated Idempotency-Key without planning again', async () => {
    mocks.state.routes.push(['WHERE idempotency_key = $1', () => ({ rows: [{ id: 'cmp_1', plan_summary: { eligible: 3, waves: [], excluded: {} } }] })])
    const res = await request(app).post('/api/v1/campaigns').set('Cookie', as('alice')).set('Idempotency-Key', 'k1').send({ name: 'Disable shared key', controlId: 'SA-02' })
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ campaignId: 'cmp_1', replayed: true })
    expect(mocks.state.calls.some((c) => c.sql.includes('INSERT INTO campaigns'))).toBe(false)
  })

  it('treats a repeated transition as a no-op and refuses an invalid one', async () => {
    mocks.state.routes.push(['SELECT status, control_id FROM campaigns', () => ({ rows: [{ status: 'running', control_id: 'SA-02' }] })])
    const again = await request(app).post('/api/v1/campaigns/cmp_1/start').set('Cookie', as('alice'))
    expect(again.body).toEqual({ status: 'running', changed: false })
    mocks.state.routes.unshift(['SELECT status, control_id FROM campaigns', () => ({ rows: [{ status: 'completed', control_id: 'SA-02' }] })])
    const pause = await request(app).post('/api/v1/campaigns/cmp_1/pause').set('Cookie', as('alice'))
    expect(pause.status).toBe(409)
    expect(pause.body.error.code).toBe('INVALID_TRANSITION')
  })

  it('cancels unstarted targets when a campaign is killed', async () => {
    mocks.state.routes.push(['SELECT status, control_id FROM campaigns', () => ({ rows: [{ status: 'running', control_id: 'SA-02' }] })])
    const res = await request(app).post('/api/v1/campaigns/cmp_1/kill').set('Cookie', as('alice'))
    expect(res.body).toEqual({ status: 'killed', changed: true })
    const cancel = mocks.state.calls.find((c) => c.sql.includes("SET state = 'cancelled'"))!
    expect(cancel.sql).toContain("state IN ('pending', 'queued')")
  })
})

describe('exceptions', () => {
  const pending = { id: 'exc_1', status: 'pending', requested_by: 'u_carol', account_id: 'a1', control_id: 'SA-02', owner: 'payments', name: 'stx' }

  it('forbids approving your own request', async () => {
    mocks.state.routes.push(['FROM exceptions e JOIN storage_accounts a ON a.id = e.account_id WHERE e.id', () => ({ rows: [pending] })])
    const res = await request(app).post('/api/v1/exceptions/exc_1/approve').set('Cookie', as('carol')).send({})
    expect(res.status).toBe(403)
    expect(res.body.error.message).toMatch(/own request/)
  })

  it('does not let owners approve', async () => {
    const res = await request(app).post('/api/v1/exceptions/exc_1/approve').set('Cookie', as('bob')).send({})
    expect(res.status).toBe(403)
  })

  it('approves, sets an expiry, and exempts the finding in the same transaction', async () => {
    mocks.state.routes.push(['FROM exceptions e JOIN storage_accounts a ON a.id = e.account_id WHERE e.id', () => ({ rows: [{ ...pending, requested_by: 'u_bob' }] })])
    mocks.state.routes.push(['UPDATE exceptions SET status = $2', () => ({ rows: [{ status: 'approved', expires_at: '2027-01-01T00:00:00Z' }] })])
    const res = await request(app).post('/api/v1/exceptions/exc_1/approve').set('Cookie', as('carol')).send({ note: 'ok until migration' })
    expect(res.status).toBe(200)
    expect(mocks.state.calls.some((c) => c.sql.includes("UPDATE findings SET status = 'exempt'"))).toBe(true)
    expect(mocks.state.calls.some((c) => c.sql.includes('INSERT INTO audit_log') && c.params[1] === 'exception.approved')).toBe(true)
  })
})

describe('prevention guardrail', () => {
  it('refuses to switch a control to deny before it is burned down, unless forced', async () => {
    mocks.state.routes.push(['WITH scoped AS', () => ({ rows: [{ control_id: 'SA-02', total: 100, open: 60, exempt: 0, safe: 0, migrate: 0, insufficient: 0, in_remediation: 0 }] })])
    const res = await request(app).put('/api/v1/controls/SA-02/policy').set('Cookie', as('alice')).send({ effect: 'deny' })
    expect(res.status).toBe(409)
    expect(res.body.error).toMatchObject({ code: 'BURN_DOWN_INCOMPLETE', details: { compliancePct: 40, open: 60 } })
  })

  it('rejects an effect the control does not support', async () => {
    const res = await request(app).put('/api/v1/controls/SA-07/policy').set('Cookie', as('alice')).send({ effect: 'deny' })
    expect(res.status).toBe(422)
  })
})
