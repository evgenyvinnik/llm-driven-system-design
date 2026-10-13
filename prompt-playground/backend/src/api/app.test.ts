import request from 'supertest'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Mock shared infrastructure before importing the app.
vi.mock('../shared/db.js', () => ({
  pool: { query: vi.fn() },
  withTransaction: vi.fn(),
}))
vi.mock('../shared/cache.js', () => ({
  redis: {
    get: vi.fn(),
    set: vi.fn(),
    del: vi.fn(),
    incr: vi.fn().mockResolvedValue(1),
    expire: vi.fn(),
    exists: vi.fn(),
    xadd: vi.fn(),
    publish: vi.fn(),
    ping: vi.fn(),
  },
  createRedisConnection: vi.fn(),
}))

import { redis } from '../shared/cache.js'
import { pool } from '../shared/db.js'
import { requestHash } from '../shared/template.js'
import { createApp } from './app.js'
import { createRunSchema } from './services/runs.js'

const app = createApp()
const query = pool.query as unknown as ReturnType<typeof vi.fn>
const user = { id: 'u1', username: 'alice', displayName: 'Alice', role: 'user', workspaceId: 'w1' }
const cookie = 'pp_session=test-session'

const runBody = {
  promptId: '1cb1e90a-afe5-465e-9340-41331ff6e80e',
  system: 'You help with {{topic}}.',
  template: 'Question: {{question}}',
  variables: { topic: 'billing', question: 'Why was I charged twice?' },
  config: { model: 'sim-fast', temperature: 0, maxTokens: 64, topP: 1 },
}

function existingRun(hash: string) {
  const at = new Date('2026-10-01T00:00:00Z')
  return {
    id: 'r1', workspace_id: 'w1', prompt_id: runBody.promptId, snapshot_id: 's1', version: 1, saved_version: 1,
    comparison_id: null, model: 'sim-fast', config: runBody.config, variables: runBody.variables,
    rendered_system: '', rendered_input: '', status: 'completed', output: 'done', output_truncated: false,
    finish_reason: 'stop', error_code: null, error_message: null, input_tokens: 10, output_tokens: 2, attempt: 1,
    created_by: 'u1', created_by_name: 'Alice', request_hash: hash, created_at: at, started_at: at,
    first_token_at: at, finished_at: at, cancel_requested_at: null,
  }
}

beforeEach(() => {
  query.mockReset()
  vi.mocked(redis.get).mockImplementation(async (key) =>
    String(key) === 'session:test-session' ? JSON.stringify(user) : null,
  )
})

describe('API', () => {
  it('reports health', async () => {
    await request(app).get('/health').expect(200, { status: 'ok' })
  })

  it('rejects unauthenticated requests', async () => {
    const res = await request(app).get('/api/v1/prompts').expect(401)
    expect(res.body.error.code).toBe('UNAUTHENTICATED')
  })

  it('requires an Idempotency-Key to start a run', async () => {
    const res = await request(app).post('/api/v1/runs').set('Cookie', cookie).send(runBody).expect(400)
    expect(res.body.error.code).toBe('IDEMPOTENCY_KEY_REQUIRED')
  })

  it('returns the original run when a request is retried with the same key', async () => {
    query.mockResolvedValueOnce({ rows: [existingRun(requestHash(createRunSchema.parse(runBody)))] })
    const res = await request(app)
      .post('/api/v1/runs')
      .set('Cookie', cookie)
      .set('Idempotency-Key', 'click-1')
      .send(runBody)
      .expect(200)
    expect(res.headers['idempotent-replayed']).toBe('true')
    expect(res.body.run.id).toBe('r1')
    expect(redis.xadd).not.toHaveBeenCalled()
  })

  it('rejects a key reused for a different request', async () => {
    query.mockResolvedValueOnce({ rows: [existingRun('some-other-hash')] })
    const res = await request(app)
      .post('/api/v1/runs')
      .set('Cookie', cookie)
      .set('Idempotency-Key', 'click-1')
      .send(runBody)
      .expect(422)
    expect(res.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED')
  })

  it('validates the model config', async () => {
    const res = await request(app)
      .post('/api/v1/runs')
      .set('Cookie', cookie)
      .set('Idempotency-Key', 'click-2')
      .send({ ...runBody, config: { model: 'sim-fast', temperature: 5 } })
      .expect(422)
    expect(res.body.error.code).toBe('VALIDATION_FAILED')
  })

  it('requires If-Match to edit a preset', async () => {
    const res = await request(app)
      .patch('/api/v1/presets/9dce4c5f-3b10-4ffd-a37f-77a20de2471b')
      .set('Cookie', cookie)
      .send({ name: 'x' })
      .expect(428)
    expect(res.body.error.code).toBe('PRECONDITION_REQUIRED')
  })

  it('serves share links without a session and rejects malformed tokens', async () => {
    await request(app).get('/api/v1/shared/not!a!token').expect(404)
  })
})
