/**
 * HTTP contract tests: status codes, headers, envelopes and access checks.
 * The services are mocked; the PATCH semantics themselves are covered by
 * domain/patch.test.ts and the live end-to-end script.
 */
import request from 'supertest'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const sessions = new Map<string, string>()

vi.mock('../shared/cache.js', () => ({
  redis: {
    get: vi.fn(async (k: string) => sessions.get(k) ?? null),
    set: vi.fn(),
    del: vi.fn(),
    incr: vi.fn().mockResolvedValue(1),
    expire: vi.fn(),
    ping: vi.fn().mockResolvedValue('PONG'),
    publish: vi.fn().mockResolvedValue(1),
  },
  createRedisConnection: vi.fn(),
  keys: {
    session: (id: string) => `ss:session:${id}`,
    rate: (b: string) => `ss:rate:${b}`,
    chaosDrop: (u: string) => `ss:chaos:${u}`,
    events: 'ss:events',
    pattern: 'ss:*',
  },
}))
vi.mock('../shared/db.js', () => ({ pool: { query: vi.fn() }, withTransaction: vi.fn() }))
vi.mock('../shared/chaos.js', () => ({
  takeDrop: vi.fn().mockResolvedValue(false),
  getChaos: vi.fn().mockResolvedValue({ dropNextPatchResponses: 0 }),
  armChaos: vi.fn(async (_u: string, s: unknown) => s),
}))
vi.mock('../services/settings-service.js', () => ({
  getEffectiveDoc: vi.fn(),
  applyUserPatch: vi.fn(),
  getUserHistory: vi.fn().mockResolvedValue([]),
  getRevisions: vi.fn(),
}))
vi.mock('../services/catalog-service.js', () => ({
  listDefinitions: vi.fn().mockResolvedValue({ catalogRevision: 1, definitions: [] }),
  createDefinition: vi.fn(),
  deprecateDefinition: vi.fn(),
}))
vi.mock('../services/policy-service.js', () => ({
  getOrgPolicy: vi.fn(),
  setOrgPolicy: vi.fn(),
  getOrgHistory: vi.fn().mockResolvedValue([]),
}))

const { createApp } = await import('./app.js')
const { HttpError } = await import('../shared/errors.js')
const settings = await import('../services/settings-service.js')
const policy = await import('../services/policy-service.js')
const catalogService = await import('../services/catalog-service.js')
const chaos = await import('../shared/chaos.js')
const { canReceive } = await import('./live.js')

const app = createApp()

function login(role: 'member' | 'org_admin' | 'platform_admin', id = 'u1', orgId = 'acme'): string {
  const sid = `sid-${role}-${id}`
  sessions.set(`ss:session:${sid}`, JSON.stringify({ id, username: id, displayName: id, role, orgId, orgName: orgId }))
  return `settings_session=${sid}`
}

const doc = { revision: 13, orgRevision: 6, catalogRevision: 1, settings: { 'appearance.theme': { value: 'dark', source: 'user', locked: false, lockReason: null, rev: 13 } } }

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(chaos.takeDrop).mockResolvedValue(false)
})

describe('auth and reads', () => {
  it('rejects unauthenticated reads with the error envelope', async () => {
    const res = await request(app).get('/api/v1/me/settings')
    expect(res.status).toBe(401)
    expect(res.body).toEqual({ error: { code: 'UNAUTHENTICATED', message: 'Sign in to continue' } })
  })

  it('returns the effective document with the user revision as ETag and the instance id', async () => {
    vi.mocked(settings.getEffectiveDoc).mockResolvedValue(doc as never)
    const res = await request(app).get('/api/v1/me/settings').set('Cookie', login('member'))
    expect(res.status).toBe(200)
    expect(res.headers.etag).toBe('"13"')
    expect(res.headers['cache-control']).toBe('no-store')
    expect(res.headers['x-instance-id']).toBeTruthy()
    expect(res.body.settings['appearance.theme'].source).toBe('user')
  })

  it('serves health without auth', async () => {
    const res = await request(app).get('/health')
    expect(res.body.status).toBe('ok')
  })
})

describe('PATCH /api/v1/me/settings', () => {
  const patch = (cookie: string) => request(app).patch('/api/v1/me/settings').set('Cookie', cookie)

  it('requires If-Match (428), never silently last-write-wins', async () => {
    const res = await patch(login('member')).send({ 'appearance.theme': 'dark' })
    expect(res.status).toBe(428)
    expect(res.body.error.code).toBe('PRECONDITION_REQUIRED')
    expect(settings.applyUserPatch).not.toHaveBeenCalled()
  })

  it('rejects a malformed If-Match, an empty patch and a non-object body', async () => {
    expect((await patch(login('member')).set('If-Match', 'yesterday').send({ a: 1 })).status).toBe(400)
    expect((await patch(login('member')).set('If-Match', '"3"').send({})).body.error.code).toBe('EMPTY_PATCH')
    expect((await patch(login('member')).set('If-Match', '"3"').send([1, 2])).body.error.code).toBe('BAD_PATCH')
  })

  it('accepts application/merge-patch+json and passes base revision and device identity through', async () => {
    vi.mocked(settings.applyUserPatch).mockResolvedValue({ ...doc, revision: 14, applied: ['appearance.theme'], unchanged: [], warnings: [] } as never)
    const res = await patch(login('member'))
      .set('If-Match', '"13"')
      .set('X-Client-Id', 'tab-1')
      .set('X-Client-Label', 'Laptop (web)')
      .set('Content-Type', 'application/merge-patch+json')
      .send(JSON.stringify({ 'appearance.theme': 'dark' }))
    expect(res.status).toBe(200)
    expect(res.headers.etag).toBe('"14"')
    expect(settings.applyUserPatch).toHaveBeenCalledWith(expect.objectContaining({ id: 'u1' }), { 'appearance.theme': 'dark' }, {
      baseRevision: 13,
      clientId: 'tab-1',
      clientLabel: 'Laptop (web)',
    })
  })

  it('returns 409 with the conflicts and the current document', async () => {
    vi.mocked(settings.applyUserPatch).mockRejectedValue(
      new HttpError(409, 'CONFLICT', 'stale', { conflicts: [{ key: 'appearance.theme', changedAtRevision: 13 }], current: doc }),
    )
    const res = await patch(login('member')).set('If-Match', '"12"').send({ 'appearance.theme': 'light' })
    expect(res.status).toBe(409)
    expect(res.body.error.conflicts[0].key).toBe('appearance.theme')
    expect(res.body.error.current.revision).toBe(13)
  })

  it('returns 422 with per-field errors', async () => {
    vi.mocked(settings.applyUserPatch).mockRejectedValue(
      new HttpError(422, 'VALIDATION_FAILED', 'bad', { fields: [{ key: 'x.y', code: 'UNKNOWN_KEY', message: 'No such setting' }], warnings: [] }),
    )
    const res = await patch(login('member')).set('If-Match', '"12"').send({ 'x.y': 1 })
    expect(res.status).toBe(422)
    expect(res.body.error.fields).toEqual([{ key: 'x.y', code: 'UNKNOWN_KEY', message: 'No such setting' }])
  })

  it('chaos: commits, then drops the response (the client sees a dead socket, not an error envelope)', async () => {
    vi.mocked(settings.applyUserPatch).mockResolvedValue({ ...doc, revision: 14, applied: ['appearance.theme'], unchanged: [], warnings: [] } as never)
    vi.mocked(chaos.takeDrop).mockResolvedValueOnce(true)
    await expect(patch(login('member')).set('If-Match', '"13"').send({ 'appearance.theme': 'dark' })).rejects.toThrow(/socket hang up|ECONNRESET/)
    expect(settings.applyUserPatch).toHaveBeenCalledTimes(1)
  })
})

describe('admin access', () => {
  it('members cannot read or write org policy', async () => {
    expect((await request(app).get('/api/v1/admin/org').set('Cookie', login('member'))).status).toBe(403)
    const res = await request(app).put('/api/v1/admin/org/policy/appearance.theme').set('Cookie', login('member')).set('If-Match', '"1"').send({ value: 'dark', enforced: true })
    expect(res.status).toBe(403)
    expect(policy.setOrgPolicy).not.toHaveBeenCalled()
  })

  it("org admins write their own org's policy (from the session) with If-Match", async () => {
    vi.mocked(policy.setOrgPolicy).mockResolvedValue({ orgRevision: 7, changed: true, item: { key: 'appearance.theme', value: 'dark', enforced: true, rev: 7 } })
    const cookie = login('org_admin', 'g1', 'globex')
    expect((await request(app).put('/api/v1/admin/org/policy/appearance.theme').set('Cookie', cookie).send({ value: 'dark', enforced: true })).status).toBe(428)
    const res = await request(app).put('/api/v1/admin/org/policy/appearance.theme').set('Cookie', cookie).set('If-Match', '"6"').send({ value: 'dark', enforced: true })
    expect(res.status).toBe(200)
    expect(res.headers.etag).toBe('"7"')
    expect(policy.setOrgPolicy).toHaveBeenCalledWith(expect.objectContaining({ orgId: 'globex' }), 'appearance.theme', 6, { value: 'dark', enforced: true })
  })

  it('only platform admins add definitions, and the body is validated', async () => {
    const body = { key: 'notifications.weekly_report', type: 'boolean', defaultValue: true, category: 'notifications', label: 'Weekly report' }
    expect((await request(app).post('/api/v1/admin/definitions').set('Cookie', login('org_admin')).send(body)).status).toBe(403)
    const bad = await request(app).post('/api/v1/admin/definitions').set('Cookie', login('platform_admin')).send({ ...body, key: 'Bad Key' })
    expect(bad.status).toBe(422)
    expect(bad.body.error.fields[0].key).toBe('key')
    vi.mocked(catalogService.createDefinition).mockResolvedValue({ key: body.key } as never)
    expect((await request(app).post('/api/v1/admin/definitions').set('Cookie', login('platform_admin')).send(body)).status).toBe(201)
  })
})

describe('SSE fan-out filter', () => {
  const alice = { user: { id: 'alice', orgId: 'acme' } } as never
  const base = { origin: 'api-a', at: '' }
  it('delivers user events only to that user, org events only to members, catalog events to everyone', () => {
    const userEvent = { ...base, type: 'user', userId: 'alice', orgId: 'acme', revision: 2, orgRevision: 1, catalogRevision: 1, changes: {}, clientId: null, clientLabel: null } as const
    expect(canReceive(alice, userEvent)).toBe(true)
    expect(canReceive(alice, { ...userEvent, userId: 'bob' })).toBe(false)
    expect(canReceive(alice, { ...base, type: 'org', orgId: 'acme', orgRevision: 2, keys: [] })).toBe(true)
    expect(canReceive(alice, { ...base, type: 'org', orgId: 'globex', orgRevision: 2, keys: [] })).toBe(false)
    expect(canReceive(alice, { ...base, type: 'catalog', catalogRevision: 2, keys: [] })).toBe(true)
  })
})
