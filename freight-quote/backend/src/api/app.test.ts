import { beforeEach, describe, expect, it, vi } from 'vitest'
import request from 'supertest'

const query = vi.fn()
vi.mock('../shared/db.js', () => ({ pool: { query }, withTransaction: vi.fn() }))
vi.mock('../shared/cache.js', () => ({ redis: { get: vi.fn(async () => null) }, createRedisConnection: vi.fn() }))

const { createApp } = await import('./app.js')
const { hashApiKey } = await import('../shared/auth.js')

const submit = vi.fn()
const app = createApp({
  redis: {} as never,
  quotes: { submit, book: vi.fn() } as never,
  stats: {} as never,
})

const body = { origin: 'HOU', destination: 'CHI', commodity: 'PLASTIC', equipment: 'COVERED_HOPPER', quantity: 4, shipWeek: '2026-11-16' }

beforeEach(() => {
  query.mockReset()
  submit.mockReset()
})

describe('quote API', () => {
  it('reports health', async () => {
    const res = await request(app).get('/health')
    expect(res.status).toBe(200)
    expect(res.body.service).toBe('quote-api')
  })

  it('requires a session or an API key to quote', async () => {
    const res = await request(app).post('/api/v1/quotes').send(body)
    expect(res.status).toBe(401)
  })

  it('rejects an unknown API key', async () => {
    query.mockResolvedValueOnce({ rows: [] })
    const res = await request(app).post('/api/v1/quotes').set('X-Api-Key', 'nope').send(body)
    expect(res.status).toBe(401)
    expect(res.body.error.code).toBe('BAD_API_KEY')
  })

  it('requires an Idempotency-Key', async () => {
    query.mockResolvedValueOnce({ rows: [{ id: 'CUST-GPX', name: 'Gulf Plastics Exchange' }] })
    const res = await request(app).post('/api/v1/quotes').set('X-Api-Key', 'fq_dev_test_1').send(body)
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('IDEMPOTENCY_KEY_REQUIRED')
    expect(query.mock.calls[0][1]).toEqual([hashApiKey('fq_dev_test_1')])
  })

  it('submits API traffic as the api class, for the key’s customer, and relays 202 + Location', async () => {
    query.mockResolvedValueOnce({ rows: [{ id: 'CUST-GPX', name: 'Gulf Plastics Exchange' }] })
    submit.mockResolvedValueOnce({ status: 202, headers: { Location: '/api/v1/quotes/q1', 'Retry-After': '2' }, body: { quote: { id: 'q1', kind: 'indicative' } } })
    const res = await request(app).post('/api/v1/quotes').set('X-Api-Key', 'fq_dev_test_2').set('Idempotency-Key', 'gpx-0001-abc').set('X-Request-Deadline-Ms', '500').send(body)
    expect(res.status).toBe(202)
    expect(res.headers.location).toBe('/api/v1/quotes/q1')
    expect(submit).toHaveBeenCalledWith(expect.objectContaining({ customerId: 'CUST-GPX', baseClass: 'api', idempotencyKey: 'gpx-0001-abc', requestedDeadlineMs: 500 }))
  })

  it('keeps the ops API behind a staff session', async () => {
    const res = await request(app).get('/api/v1/ops/overview')
    expect(res.status).toBe(401)
  })
})
