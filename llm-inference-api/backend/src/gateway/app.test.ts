import request from 'supertest'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const query = vi.fn()
const runScript = vi.fn()

vi.mock('../shared/db.js', () => ({ pool: { query: (...a: unknown[]) => query(...a) }, withTransaction: vi.fn() }))
vi.mock('../shared/cache.js', () => {
  const keyFn = new Proxy({}, { get: (_t, k) => (...a: unknown[]) => `inf:${String(k)}:${a.join(':')}` })
  const redis = { get: vi.fn().mockResolvedValue(null), hgetall: vi.fn().mockResolvedValue({}), hmget: vi.fn().mockResolvedValue([null, null]), publish: vi.fn(), exists: vi.fn() }
  return {
    redis,
    keys: keyFn,
    CLASSES: ['interactive', 'batch'],
    runScript: (...a: unknown[]) => runScript(...a),
    countStat: vi.fn().mockResolvedValue(undefined),
    minuteBucket: () => 0,
    createRedisConnection: () => redis,
  }
})

const { createApp } = await import('./app.js')
const app = createApp()

const principalRow = {
  key_id: '11111111-1111-1111-1111-111111111111', key_name: 'production', org_id: '22222222-2222-2222-2222-222222222222', slug: 'acme', org_name: 'Acme Robotics',
  tier: 'scale', tokens_per_minute: 200000, requests_per_minute: 600, max_queued_interactive: 24, max_queued_batch: 150, weight: 4,
}
const body = { model: 'mock-large', max_tokens: 100, messages: [{ role: 'user', content: 'hi' }] }

beforeEach(() => {
  query.mockReset()
  runScript.mockReset()
  query.mockImplementation(async (sql: string) => (sql.includes('FROM api_keys k JOIN orgs') ? { rows: [principalRow] } : { rows: [], rowCount: 0 }))
})

describe('gateway HTTP surface', () => {
  it('serves health and the model list', async () => {
    expect((await request(app).get('/health')).status).toBe(200)
    const r = await request(app).get('/v1/models')
    expect(r.body.data[0].id).toBe('mock-large')
  })

  it('rejects a missing API key with authentication_error', async () => {
    const r = await request(app).post('/v1/messages').send(body)
    expect(r.status).toBe(401)
    expect(r.body).toEqual({ type: 'error', error: { type: 'authentication_error', message: 'Missing x-api-key header' } })
  })

  it('rejects an unknown API key', async () => {
    query.mockResolvedValue({ rows: [] })
    const r = await request(app).post('/v1/messages').set('x-api-key', 'sk-nope').send(body)
    expect(r.status).toBe(401)
  })

  it('validates the body before admission', async () => {
    const r = await request(app).post('/v1/messages').set('x-api-key', 'sk-test-a').send({ model: 'mock-large', messages: [] })
    expect(r.status).toBe(400)
    expect(r.body.error.type).toBe('invalid_request_error')
    expect(runScript).not.toHaveBeenCalled()
  })

  it('answers 404 for an unknown model', async () => {
    const r = await request(app).post('/v1/messages').set('x-api-key', 'sk-test-b').send({ ...body, model: 'gpt-x' })
    expect(r.status).toBe(404)
  })

  it('a tenant over its token budget gets 429 with Retry-After, without a database write', async () => {
    runScript.mockResolvedValue(['rate_limited_tokens', 2500, 100])
    const r = await request(app).post('/v1/messages').set('x-api-key', 'sk-test-c').send(body)
    expect(r.status).toBe(429)
    expect(r.body.error.type).toBe('rate_limit_error')
    expect(r.headers['retry-after']).toBe('3')
    expect(query.mock.calls.some(([sql]) => String(sql).startsWith('INSERT INTO requests'))).toBe(false)
  })

  it('a full class queue gets 529 overloaded_error, a different contract from 429', async () => {
    runScript.mockResolvedValue(['overloaded', 0, 5000])
    const r = await request(app).post('/v1/messages/async').set('x-api-key', 'sk-test-d').send(body)
    expect(r.status).toBe(529)
    expect(r.body.error.type).toBe('overloaded_error')
  })

  it('a request larger than the burst is a 400, not a 429 (retrying would never help)', async () => {
    runScript.mockResolvedValue(['too_large', 0, 6000])
    const r = await request(app).post('/v1/messages').set('x-api-key', 'sk-test-e').send(body)
    expect(r.status).toBe(400)
  })

  it('charges cost = estimated input + max_tokens', async () => {
    runScript.mockResolvedValue(['rate_limited_tokens', 1, 0])
    await request(app).post('/v1/messages').set('x-api-key', 'sk-test-f').send({ ...body, max_tokens: 1000 })
    const [name, , args] = runScript.mock.calls[0] as [string, string[], (string | number)[]]
    expect(name).toBe('ADMIT')
    expect(args[1]).toBe(1000 + 5) // "hi" → 1 token + 4 per-message overhead
  })

  it('console and admin APIs require a session', async () => {
    expect((await request(app).get('/api/v1/console/orgs')).status).toBe(401)
    expect((await request(app).get('/api/v1/admin/overview')).status).toBe(401)
  })
})
