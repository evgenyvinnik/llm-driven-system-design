import request from 'supertest'
import { describe, expect, it, vi } from 'vitest'

vi.mock('../shared/db.js', () => ({
  pool: { query: vi.fn().mockResolvedValue({ rows: [] }), connect: vi.fn() },
  withTransaction: vi.fn(),
  lockKey: () => 1,
}))
vi.mock('../shared/cache.js', () => ({
  redis: { get: vi.fn().mockResolvedValue(null), ping: vi.fn().mockResolvedValue('PONG'), incr: vi.fn().mockResolvedValue(1), expire: vi.fn() },
  createRedisConnection: vi.fn(),
}))

const { createApp } = await import('./app.js')
const app = createApp()

describe('API', () => {
  it('reports health', async () => {
    const res = await request(app).get('/health')
    expect(res.status).toBe(200)
  })

  it('refuses ingest without the gateway token', async () => {
    const res = await request(app).post('/api/v1/ingest/batches').send({ sourceId: 'GW-CAN-1', batchId: 'b', events: [] })
    expect(res.status).toBe(401)
    expect(res.body.error.code).toBe('BAD_INGEST_TOKEN')
  })

  it('validates the batch envelope (payloads are validated later, by consumers)', async () => {
    const res = await request(app)
      .post('/api/v1/ingest/batches')
      .set('X-Ingest-Token', 'local-dev-ingest-token')
      .send({ sourceId: 'GW-CAN-1', batchId: 'b', events: [{ eventId: 'not-a-uuid', seq: 1, type: 'SlideFenceTripped', version: 1, occurredAt: 'yesterday', payload: {} }] })
    expect(res.status).toBe(422)
    expect(res.body.error.code).toBe('VALIDATION_FAILED')
  })

  it('rejects batches from unknown gateways', async () => {
    const res = await request(app).post('/api/v1/ingest/batches').set('X-Ingest-Token', 'local-dev-ingest-token').send({ sourceId: 'GW-NOPE', batchId: 'b', events: [] })
    expect(res.status).toBe(403)
  })

  it('requires a session for the operator APIs', async () => {
    expect((await request(app).get('/api/v1/board')).status).toBe(401)
    expect((await request(app).post('/api/v1/ops/replay/hazards')).status).toBe(401)
  })
})
