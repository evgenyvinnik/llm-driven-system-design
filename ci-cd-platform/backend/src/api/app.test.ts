/**
 * The HTTP surface with shared modules mocked: authentication gates, webhook verification
 * before parsing, and the error envelope. What needs a database is in engine.race.test.ts;
 * the whole system together is exercised by the live end-to-end script.
 */
import request from 'supertest'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { poolQuery, handleDelivery, keys } = vi.hoisted(() => ({
  poolQuery: vi.fn(),
  handleDelivery: vi.fn(),
  keys: { session: (id: string) => `session:${id}`, rate: (b: string) => `rate:${b}`, logChannel: 'logs' },
}))

vi.mock('../shared/db.js', () => ({
  pool: { query: poolQuery, connect: vi.fn(), end: vi.fn() },
  withTransaction: vi.fn(),
}))
vi.mock('../shared/cache.js', () => ({
  redis: { get: vi.fn().mockResolvedValue(null), set: vi.fn(), del: vi.fn(), ping: vi.fn().mockResolvedValue('PONG'), incr: vi.fn().mockResolvedValue(1), expire: vi.fn(), publish: vi.fn() },
  keys,
  createRedisConnection: vi.fn(),
}))
vi.mock('../shared/storage.js', () => ({ ensureBucket: vi.fn(), putBlob: vi.fn(), getBlob: vi.fn(), deleteBlob: vi.fn(), logArchiveKey: vi.fn(), artifactKey: vi.fn() }))
vi.mock('../intake/events.js', () => ({ handleDelivery }))

import { encrypt } from '../shared/crypto.js'
import { signBody } from '../intake/signature.js'
import { webhookAad } from './routes/webhooks.js'
import { createApp } from './app.js'

const app = createApp()
const SECRET = 'whsec_test'
const repoRow = { id: 'repo_1', webhook_secret_enc: encrypt(SECRET, webhookAad('repo_1')) }
const body = JSON.stringify({ ref: 'refs/heads/main', after: 'a'.repeat(40), repository: { full_name: 'acme/web-app' } })

function post(signature: string | null, delivery: string | null = 'd-1', event: string | null = 'push') {
  let r = request(app).post('/api/v1/webhooks/acme/web-app').set('Content-Type', 'application/json')
  if (signature) r = r.set('X-Hub-Signature-256', signature)
  if (delivery) r = r.set('X-GitHub-Delivery', delivery)
  if (event) r = r.set('X-GitHub-Event', event)
  return r.send(body)
}

beforeEach(() => {
  poolQuery.mockReset()
  handleDelivery.mockReset()
  poolQuery.mockResolvedValue({ rows: [repoRow] })
})

describe('webhook intake', () => {
  it('rejects a missing signature', async () => {
    const res = await post(null)
    expect(res.status).toBe(401)
    expect(res.body.error.code).toBe('BAD_SIGNATURE')
    expect(handleDelivery).not.toHaveBeenCalled()
  })

  it('rejects a wrong signature without looking at the event', async () => {
    const res = await post(signBody('wrong-key', body))
    expect(res.status).toBe(401)
    expect(handleDelivery).not.toHaveBeenCalled()
  })

  it('gives an unknown repository the same answer as a bad signature', async () => {
    poolQuery.mockResolvedValue({ rows: [] })
    const res = await post(signBody(SECRET, body))
    expect(res.status).toBe(401)
    expect(res.body.error.code).toBe('BAD_SIGNATURE')
  })

  it('verifies the raw bytes, not a re-serialization', async () => {
    handleDelivery.mockResolvedValue({ duplicate: false, runId: 'run_1', runNumber: 1, outcome: 'created_run', detail: null })
    const res = await post(signBody(SECRET, body))
    expect(res.status).toBe(202)
    expect(handleDelivery.mock.calls[0][0].rawBody.toString()).toBe(body)
  })

  it('requires a delivery id and an event type', async () => {
    expect((await post(signBody(SECRET, body), null)).status).toBe(400)
    expect((await post(signBody(SECRET, body), 'd', null)).status).toBe(400)
  })

  it('answers a duplicate with 200 and the existing run', async () => {
    handleDelivery.mockResolvedValue({ duplicate: true, runId: 'run_1', runNumber: 1, outcome: 'created_run', detail: null })
    const res = await post(signBody(SECRET, body))
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ duplicate: true, runId: 'run_1' })
  })

  it('rejects a signed body that is not JSON', async () => {
    const res = await request(app).post('/api/v1/webhooks/acme/web-app').set('X-Hub-Signature-256', signBody(SECRET, 'not json')).set('X-GitHub-Delivery', 'd').set('X-GitHub-Event', 'push').set('Content-Type', 'application/json').send('not json')
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('INVALID_JSON')
  })
})

describe('authentication gates', () => {
  it.each(['/api/v1/repos', '/api/v1/runs/x', '/api/v1/jobs/x', '/api/v1/jobs/x/attempts/1/logs/stream', '/api/v1/artifacts/x/download', '/api/v1/runners', '/api/v1/ops/overview', '/api/v1/fixtures/catalog', '/api/v1/auth/me'])('%s needs a session', async (path) => {
    const res = await request(app).get(path)
    expect(res.status).toBe(401)
    expect(res.body.error.code).toBe('UNAUTHENTICATED')
  })

  it.each(['/api/v1/runs/x/cancel', '/api/v1/runs/x/rerun', '/api/v1/jobs/x/rerun', '/api/v1/jobs/x/approval', '/api/v1/jobs/x/resolve', '/api/v1/fixtures/trigger', '/api/v1/fixtures/kill-runner'])('POST %s needs a session', async (path) => {
    expect((await request(app).post(path).send({})).status).toBe(401)
  })
})

describe('runner API', () => {
  it('needs a registration token to register', async () => {
    const res = await request(app).post('/api/v1/runner/register').send({ name: 'r', labels: ['linux'] })
    expect(res.status).toBe(401)
    expect(res.body.error.code).toBe('BAD_REGISTRATION_TOKEN')
  })

  it('needs a runner token for everything else', async () => {
    for (const path of ['/api/v1/runner/claim', '/api/v1/runner/heartbeat', '/api/v1/runner/jobs/x/logs', '/api/v1/runner/jobs/x/complete']) {
      expect((await request(app).post(path).send({})).status).toBe(401)
    }
  })

  it('rejects an unknown runner token', async () => {
    poolQuery.mockResolvedValue({ rows: [] })
    const res = await request(app).post('/api/v1/runner/claim').set('Authorization', 'Bearer nope')
    expect(res.status).toBe(401)
  })
})

describe('app shell', () => {
  it('reports health and 404s with the error envelope', async () => {
    expect((await request(app).get('/health')).status).toBe(200)
    const missing = await request(app).get('/api/v1/nope')
    expect(missing.status).toBe(404)
    expect(missing.body.error.code).toBe('NOT_FOUND')
  })
})
