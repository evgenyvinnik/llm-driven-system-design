import request from 'supertest'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const sessions: Record<string, unknown> = {
  'dq:session:alice': { id: 'usr_alice', username: 'alice', displayName: 'Alice', role: 'org_admin', orgId: 'org_acme', orgName: 'Acme', groupIds: ['grp_acme_eng'], claimsAt: Date.now() },
  'dq:session:admin': { id: 'usr_admin', username: 'admin', displayName: 'Ops', role: 'operator', orgId: null, orgName: null, groupIds: [], claimsAt: Date.now() },
}

const query = vi.fn()
vi.mock('../shared/db.js', () => ({
  pool: { query: (...args: unknown[]) => query(...args) },
  withTransaction: vi.fn(),
  withSnapshot: vi.fn(),
}))
vi.mock('../shared/cache.js', () => ({
  redis: { get: vi.fn(async (k: string) => (sessions[k] ? JSON.stringify(sessions[k]) : null)), set: vi.fn(), ping: vi.fn() },
  keys: { session: (id: string) => `dq:session:${id}`, answersByDoc: (d: string) => `dq:ansdoc:${d}`, runEvents: (r: string) => `dq:run:${r}:events`, cancelChannel: 'dq:cancel' },
  createRedisConnection: vi.fn(),
}))
vi.mock('../shared/storage.js', () => ({ putBlob: vi.fn(), ensureBucket: vi.fn(), blobKey: () => 'k', getBlob: vi.fn(), deleteBlobs: vi.fn() }))
vi.mock('./services/publish.js', () => ({ publishJobs: vi.fn(), getPublisher: vi.fn() }))

const { createApp } = await import('./app.js')
const app = createApp()

beforeEach(() => query.mockReset())

describe('api', () => {
  it('reports health', async () => {
    expect((await request(app).get('/health')).body).toEqual({ status: 'ok' })
  })

  it('requires a session for the library', async () => {
    const res = await request(app).get('/api/v1/documents')
    expect(res.status).toBe(401)
    expect(res.body.error.code).toBe('UNAUTHENTICATED')
  })

  it('keeps operators out of document content and members out of ops', async () => {
    expect((await request(app).get('/api/v1/documents').set('Cookie', 'docqa_session=admin')).status).toBe(403)
    expect((await request(app).get('/api/v1/ops/overview').set('Cookie', 'docqa_session=alice')).status).toBe(403)
  })

  it('rejects an unsupported file type with a reason before storing anything', async () => {
    const res = await request(app)
      .post('/api/v1/documents')
      .set('Cookie', 'docqa_session=alice')
      .set('Idempotency-Key', 'k-1')
      .attach('file', Buffer.from('%PDF-1.7 ...'), 'scan.pdf')
    expect(res.status).toBe(415)
    expect(res.body.error).toMatchObject({ code: 'UNSUPPORTED_TYPE' })
    expect(res.body.error.message).toMatch(/PDF extraction is not enabled/)
    expect(query).not.toHaveBeenCalled()
  })

  it('requires a file in the upload', async () => {
    const res = await request(app).post('/api/v1/documents').set('Cookie', 'docqa_session=alice').field('title', 'x')
    expect(res.status).toBe(422)
    expect(res.body.error.code).toBe('FILE_REQUIRED')
  })

  it('validates questions and sharing changes', async () => {
    expect((await request(app).post('/api/v1/answers').set('Cookie', 'docqa_session=alice').send({ question: 'x' })).status).toBe(422)
    const bad = await request(app).patch('/api/v1/documents/doc_1/sharing').set('Cookie', 'docqa_session=alice').send({ scope: 'group' })
    expect(bad.status).toBe(422)
  })

  it('returns 404 for a document the member cannot read (deleted, unshared or another tenant)', async () => {
    query.mockResolvedValueOnce({ rows: [] })
    const res = await request(app).get('/api/v1/documents/doc_x').set('Cookie', 'docqa_session=alice')
    expect(res.status).toBe(404)
    const [sql, params] = query.mock.calls[0] as [string, unknown[]]
    expect(sql).toContain('d.deleted_at IS NULL')
    expect(params).toEqual(['org_acme', 'usr_alice', 'doc_x'])
  })
})
