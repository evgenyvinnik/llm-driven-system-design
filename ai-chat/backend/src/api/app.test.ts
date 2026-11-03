import request from 'supertest'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Mock shared infrastructure before importing the app.
vi.mock('../shared/db.js', () => ({
  pool: { query: vi.fn(), connect: vi.fn() },
  withTransaction: vi.fn(),
}))
vi.mock('../shared/cache.js', () => ({
  redis: {
    get: vi.fn(),
    set: vi.fn(),
    del: vi.fn(),
    exists: vi.fn(),
    incr: vi.fn().mockResolvedValue(1),
    expire: vi.fn(),
    eval: vi.fn().mockResolvedValue('1-0'),
    xadd: vi.fn(),
    publish: vi.fn(),
    ping: vi.fn(),
  },
  createRedisConnection: vi.fn(),
}))

import { redis } from '../shared/cache.js'
import { pool } from '../shared/db.js'
import { createApp } from './app.js'
import { requestHash } from './services/generations.js'

const app = createApp()
const query = pool.query as unknown as ReturnType<typeof vi.fn>
const alice = { id: '0b8c5b8e-1111-4c1e-9a52-6a1f0f3e0001', username: 'alice', displayName: 'Alice', role: 'user' }
const cookie = 'chat_session=test-session'
const conversationId = '5f0c7a51-2222-4a7b-8a1d-1c2b3d4e0001'
const userMessageId = '5f0c7a51-3333-4a7b-8a1d-1c2b3d4e0001'
const assistantMessageId = '5f0c7a51-4444-4a7b-8a1d-1c2b3d4e0001'
const at = new Date('2026-10-01T00:00:00Z')

function generationRow(hash: string) {
  return {
    id: '5f0c7a51-5555-4a7b-8a1d-1c2b3d4e0001', conversation_id: conversationId, user_id: alice.id,
    user_message_id: userMessageId, assistant_message_id: assistantMessageId, kind: 'message', model: 'sim-swift',
    status: 'running', request_hash: hash, attempt: 1, output: 'Partial answer so far', checkpoint_event_id: '1700-3',
    output_truncated: false, finish_reason: null, error_code: null, error_message: null, input_tokens: 9,
    output_tokens: 4, context_messages: 1, context_dropped: 0, created_at: at, started_at: at, first_token_at: at,
    finished_at: null, cancel_requested_at: null,
  }
}

const conversationRow = {
  id: conversationId, user_id: alice.id, title: 'Trip', model: 'sim-swift', current_leaf_id: assistantMessageId,
  created_at: at, updated_at: at, updated_cursor: '2026-10-01T00:00:00.000000Z', active_generation_id: null,
}
const messageRows = [
  { id: userMessageId, conversation_id: conversationId, parent_id: null, role: 'user', content: 'Plan a trip', depth: 0, created_at: at },
  { id: assistantMessageId, conversation_id: conversationId, parent_id: userMessageId, role: 'assistant', content: '', depth: 1, created_at: at },
]

beforeEach(() => {
  query.mockReset()
  vi.mocked(redis.get).mockImplementation(async (key) =>
    String(key) === 'session:test-session' ? JSON.stringify(alice) : null,
  )
})

describe('authentication', () => {
  it('rejects conversation routes without a session', async () => {
    const res = await request(app).get('/api/v1/conversations')
    expect(res.status).toBe(401)
    expect(res.body.error.code).toBe('UNAUTHENTICATED')
  })

  it('rejects the generation stream without a session', async () => {
    const res = await request(app).get(`/api/v1/generations/${generationRow('h').id}/events`)
    expect(res.status).toBe(401)
  })

  it('rejects the device event stream without a session', async () => {
    const res = await request(app).get('/api/v1/events')
    expect(res.status).toBe(401)
  })
})

describe('authorization', () => {
  it("reports another user's conversation as not found", async () => {
    query.mockResolvedValue({ rows: [], rowCount: 0 })
    const res = await request(app).get(`/api/v1/conversations/${conversationId}`).set('Cookie', cookie)
    expect(res.status).toBe(404)
    const [sql, params] = query.mock.calls[0]
    expect(sql).toContain('c.user_id = $2')
    expect(params).toEqual([conversationId, alice.id])
  })

  it("does not open a stream for another user's generation", async () => {
    query.mockResolvedValue({ rows: [], rowCount: 0 })
    const res = await request(app).get(`/api/v1/generations/${generationRow('h').id}/events`).set('Cookie', cookie)
    expect(res.status).toBe(404)
    expect(query.mock.calls[0][0]).toContain('c.user_id = $2')
  })

  it('treats a malformed ID as not found without querying', async () => {
    const res = await request(app).get('/api/v1/conversations/not-a-uuid').set('Cookie', cookie)
    expect(res.status).toBe(404)
    expect(query).not.toHaveBeenCalled()
  })

  it('keeps the admin API to operators', async () => {
    const res = await request(app).get('/api/v1/admin/overview').set('Cookie', cookie)
    expect(res.status).toBe(403)
  })
})

describe('idempotent generation requests', () => {
  const body = { content: 'Plan a trip', parentMessageId: null }
  const hash = requestHash({ op: 'message', conversationId, ...body })

  function mockReplayQueries(storedHash: string) {
    query.mockImplementation(async (sql: string) => {
      if (sql.includes('idempotency_key = $2')) return { rows: [generationRow(storedHash)] }
      if (sql.includes('FROM conversations c WHERE c.id = $1')) return { rows: [conversationRow] }
      if (sql.startsWith('SELECT * FROM messages WHERE id = ANY')) return { rows: messageRows }
      if (sql.includes('m.parent_id IS NOT DISTINCT FROM t.parent_id')) {
        return { rows: messageRows.map((m) => ({ id: m.id, parent_id: m.parent_id })) }
      }
      return { rows: [] }
    })
  }

  it('requires an Idempotency-Key', async () => {
    const res = await request(app)
      .post(`/api/v1/conversations/${conversationId}/messages`)
      .set('Cookie', cookie)
      .send(body)
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('IDEMPOTENCY_KEY_REQUIRED')
  })

  it('returns the existing generation for a retried key instead of creating another', async () => {
    mockReplayQueries(hash)
    const res = await request(app)
      .post(`/api/v1/conversations/${conversationId}/messages`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', 'click-1')
      .send(body)
    expect(res.status).toBe(200)
    expect(res.headers['idempotent-replayed']).toBe('true')
    expect(res.body.generation.id).toBe(generationRow(hash).id)
    // The in-flight answer carries its checkpoint, so the client can resume after checkpointEventId.
    expect(res.body.assistantMessage.content).toBe('Partial answer so far')
    expect(res.body.generation.checkpointEventId).toBe('1700-3')
    expect(pool.connect).not.toHaveBeenCalled()
    expect(redis.xadd).not.toHaveBeenCalled()
  })

  it('rejects a key reused for a different request', async () => {
    mockReplayQueries('some-other-hash')
    const res = await request(app)
      .post(`/api/v1/conversations/${conversationId}/messages`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', 'click-1')
      .send(body)
    expect(res.status).toBe(422)
    expect(res.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED')
  })

  it('validates the message body', async () => {
    const res = await request(app)
      .post(`/api/v1/conversations/${conversationId}/messages`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', 'click-2')
      .send({ content: '   ', parentMessageId: null })
    expect(res.status).toBe(422)
    expect(res.body.error.code).toBe('VALIDATION_FAILED')
  })
})

describe('requestHash', () => {
  it('distinguishes a regeneration from a new message with the same text', () => {
    const message = requestHash({ op: 'message', conversationId, content: 'x', parentMessageId: null })
    const regen = requestHash({ op: 'regenerate', conversationId, userMessageId })
    expect(message).not.toBe(regen)
  })
})
