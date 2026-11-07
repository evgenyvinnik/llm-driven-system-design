import request from 'supertest'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Mock shared modules before importing the app.
const query = vi.fn()
const clientQuery = vi.fn()
vi.mock('../shared/db.js', () => ({
  pool: { query: (...args: unknown[]) => query(...args) },
  withTransaction: async (fn: (c: { query: typeof clientQuery }) => Promise<unknown>) => fn({ query: clientQuery }),
}))
const sessions = new Map<string, string>()
vi.mock('../shared/cache.js', () => ({
  redis: {
    get: async (k: string) => sessions.get(k) ?? null,
    set: async () => 'OK',
    del: async () => 1,
    incr: async () => 1,
    expire: async () => 1,
    ping: async () => 'PONG',
  },
  keys: { session: (id: string) => `wh:session:${id}`, rate: (b: string) => `wh:rate:${b}`, endpointSlots: (id: string) => `wh:slots:${id}` },
}))

const { createApp } = await import('./app.js')
const { requestHash } = await import('./services/emit.js')
const app = createApp()

const alice = { id: 'usr_alice', username: 'alice', displayName: 'Alice', role: 'customer', orgId: 'org_acme', orgName: 'Acme Corp' }
sessions.set('wh:session:alice-sid', JSON.stringify(alice))
const asAlice = 'webhooks_session=alice-sid'

beforeEach(() => {
  query.mockReset()
  clientQuery.mockReset()
})

describe('event intake', () => {
  it('requires a producer identity', async () => {
    const res = await request(app).post('/api/v1/events').send({ type: 'order.created', data: {} })
    expect(res.status).toBe(401)
  })

  it('rejects an unknown API key', async () => {
    query.mockResolvedValueOnce({ rows: [] })
    const res = await request(app).post('/api/v1/events').set('authorization', 'Bearer whk_nope').set('idempotency-key', 'k1').send({ type: 'order.created', data: {} })
    expect(res.status).toBe(401)
    expect(res.body.error.code).toBe('BAD_API_KEY')
  })

  it('requires an Idempotency-Key', async () => {
    query.mockResolvedValueOnce({ rows: [{ id: 'key_1', org_id: 'org_acme', stale: false }] })
    const res = await request(app).post('/api/v1/events').set('authorization', 'Bearer whk_ok').send({ type: 'order.created', data: {} })
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('IDEMPOTENCY_KEY_REQUIRED')
  })

  it('validates the event type', async () => {
    query.mockResolvedValueOnce({ rows: [{ id: 'key_1', org_id: 'org_acme', stale: false }] })
    const res = await request(app).post('/api/v1/events').set('authorization', 'Bearer whk_ok').set('idempotency-key', 'k1').send({ type: 'Order Created', data: {} })
    expect(res.status).toBe(422)
  })

  it('a retried emit with the same key and body returns the original event (200, Idempotent-Replayed)', async () => {
    const body = { type: 'order.created', data: { orderId: '1' } }
    query.mockResolvedValueOnce({ rows: [{ id: 'key_1', org_id: 'org_acme', stale: false }] })
    const existing = { id: 'evt_1', org_id: 'org_acme', type: 'order.created', payload: { orderId: '1' }, ordering_key: null, sequence: null, idempotency_key: 'k1', request_hash: requestHash(body), source: 'api', created_at: new Date() }
    clientQuery
      .mockResolvedValueOnce({ rows: [] }) // advisory lock
      .mockResolvedValueOnce({ rows: [existing] }) // existing event
      .mockResolvedValueOnce({ rows: [{ id: 'dlv_1', endpoint_id: 'ep_1' }] }) // its deliveries
    const res = await request(app).post('/api/v1/events').set('authorization', 'Bearer whk_ok').set('idempotency-key', 'k1').send(body)
    expect(res.status).toBe(200)
    expect(res.headers['idempotent-replayed']).toBe('true')
    expect(res.body).toMatchObject({ replayed: true, event: { id: 'evt_1' }, deliveries: [{ id: 'dlv_1', endpointId: 'ep_1' }] })
  })

  it('the same key with a different body is a 409', async () => {
    query.mockResolvedValueOnce({ rows: [{ id: 'key_1', org_id: 'org_acme', stale: false }] })
    clientQuery.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [{ id: 'evt_1', request_hash: 'something-else' }] })
    const res = await request(app).post('/api/v1/events').set('authorization', 'Bearer whk_ok').set('idempotency-key', 'k1').send({ type: 'order.created', data: { orderId: '2' } })
    expect(res.status).toBe(409)
    expect(res.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED')
  })
})

describe('endpoints', () => {
  it('rejects the cloud metadata address at registration (and workers check again per connection)', async () => {
    const res = await request(app).post('/api/v1/endpoints').set('cookie', asAlice).send({ url: 'http://169.254.169.254/latest/meta-data/' })
    expect(res.status).toBe(422)
    expect(res.body.error.code).toBe('SSRF_BLOCKED')
    expect(query).not.toHaveBeenCalled()
  })

  it("another org's endpoint is a 404, never a 403 that would confirm it exists", async () => {
    query.mockResolvedValueOnce({ rows: [] })
    const res = await request(app).get('/api/v1/endpoints/ep_globex_main').set('cookie', asAlice)
    expect(res.status).toBe(404)
    expect(query.mock.calls[0][1]).toEqual(['org_acme', 'ep_globex_main'])
  })

  it('needs a session', async () => {
    expect((await request(app).get('/api/v1/endpoints')).status).toBe(401)
  })
})

describe('access', () => {
  it('customers cannot read the operator overview', async () => {
    expect((await request(app).get('/api/v1/ops/overview').set('cookie', asAlice)).status).toBe(403)
  })

  it('the receiver-secrets endpoint needs the internal token', async () => {
    expect((await request(app).get('/api/v1/internal/receiver-secrets?path=/hooks/acme-orders')).status).toBe(401)
  })

  it('health is public', async () => {
    expect((await request(app).get('/health')).body).toEqual({ status: 'ok' })
  })
})
