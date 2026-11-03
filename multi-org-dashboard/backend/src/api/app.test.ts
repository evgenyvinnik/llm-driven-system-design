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
    eval: vi.fn(),
    incr: vi.fn().mockResolvedValue(1),
    expire: vi.fn(),
    publish: vi.fn(),
    ping: vi.fn(),
  },
  createRedisConnection: vi.fn(),
}))

import type { Router } from 'express'
import type { EffectiveAccess } from '../shared/access.js'
import { redis } from '../shared/cache.js'
import { pool } from '../shared/db.js'
import { routeInventory } from '../shared/org-access.js'
import { computeAccess, type Plan, type Role } from '../shared/permissions.js'
import { createApp, ORG_BASE } from './app.js'
import { adminRouter } from './routes/admin.js'
import { agentsRouter } from './routes/agents.js'
import { conversationsRouter } from './routes/conversations.js'
import { exportsRouter } from './routes/exports.js'
import { orgRouter } from './routes/org.js'
import { promptsRouter } from './routes/prompts.js'

const app = createApp()
const query = pool.query as unknown as ReturnType<typeof vi.fn>
const cookie = 'mod_session=test-session'
const PROJECT = '0b7c2f4e-9a51-4a0e-8f3d-2c6b1e5d7a90'
const AGENT = '5e0d9f1a-3c2b-4e8d-9a7f-1b6c4d2e8f30'

let session: Record<string, unknown>
let cache: Record<string, string>

function accessFor(role: Role, opts: { plan?: Plan; flag?: boolean; version?: number; previewRole?: Role } = {}): EffectiveAccess {
  const computed = computeAccess({
    role,
    previewRole: opts.previewRole,
    plan: opts.plan ?? 'pro',
    flagDefinitions: [{ key: 'prompt_library', defaultEnabled: false }],
    flagRules: opts.flag ? [{ flagKey: 'prompt_library', enabled: true, roles: [] }] : [],
  })
  return {
    ...computed,
    orgId: 'org_lumen',
    orgName: 'Lumen Outfitters',
    plan: opts.plan ?? 'pro',
    branding: { accent: 'teal', initials: 'LO' },
    userId: 'u1',
    projects: [{ id: PROJECT, name: 'Storefront', restricted: false }],
    projectIds: [PROJECT],
    version: opts.version ?? 3,
  }
}

/** Puts an access entry in the fake Valkey under the current version, as a previous request would have. */
function cacheAccess(access: EffectiveAccess, previewRole?: Role) {
  cache['authz:ver:org_lumen'] = String(access.version)
  cache[`perm:org_lumen:u1:v${access.version}${previewRole ? `:as-${previewRole}` : ''}`] = JSON.stringify(access)
}

/** The three queries computeFromDatabase makes, answering as PostgreSQL would for this role (null = not a member). */
function databaseSays(role: Role | null, opts: { plan?: Plan; version?: number } = {}) {
  if (role === null) {
    query.mockResolvedValueOnce({ rows: [] })
    return
  }
  query
    .mockResolvedValueOnce({
      rows: [{ id: 'org_lumen', name: 'Lumen Outfitters', plan: opts.plan ?? 'pro', branding: {}, authz_version: opts.version ?? 3, role }],
    })
    .mockResolvedValueOnce({ rows: [{ id: PROJECT, name: 'Storefront', restricted: false }] })
    .mockResolvedValueOnce({ rows: [{ key: 'prompt_library', default_enabled: false, enabled: null, roles: null }] })
}

beforeEach(() => {
  query.mockReset()
  session = { id: 'u1', email: 'alice@example.com', displayName: 'Alice' }
  cache = {}
  vi.mocked(redis.get).mockImplementation(async (key) => {
    if (String(key) === 'session:test-session') return JSON.stringify(session)
    return cache[String(key)] ?? null
  })
})

describe('authentication and org membership', () => {
  it('reports health', async () => {
    await request(app).get('/health').expect(200, { status: 'ok' })
  })

  it('answers 401 without a session, before looking at the org', async () => {
    const res = await request(app).get('/api/v1/orgs/org_lumen/agents').expect(401)
    expect(res.body.error.code).toBe('UNAUTHENTICATED')
    expect(query).not.toHaveBeenCalled()
  })

  it('answers 404 for a malformed org id without touching PostgreSQL', async () => {
    await request(app).get("/api/v1/orgs/org_lumen'--/agents").set('Cookie', cookie).expect(404)
    expect(query).not.toHaveBeenCalled()
  })

  it('answers 404, not 403, for an org the user is not a member of', async () => {
    databaseSays(null)
    const res = await request(app).get('/api/v1/orgs/org_harbor/agents').set('Cookie', cookie).expect(404)
    expect(res.body.error).toMatchObject({ code: 'NOT_FOUND', message: 'Organization not found' })
  })

  it('tags every org-scoped response with the org and its authz version', async () => {
    cacheAccess(accessFor('viewer', { version: 7 }))
    query.mockResolvedValueOnce({ rows: [] })
    const res = await request(app).get('/api/v1/orgs/org_lumen/agents').set('Cookie', cookie).expect(200)
    expect(res.headers['x-org-id']).toBe('org_lumen')
    expect(res.headers['x-authz-version']).toBe('7')
  })
})

describe('permissions, flags and entitlements', () => {
  it('answers 403 with the missing permission when the role lacks it', async () => {
    cacheAccess(accessFor('viewer'))
    const res = await request(app).get('/api/v1/orgs/org_lumen/billing').set('Cookie', cookie).expect(403)
    expect(res.body.error.code).toBe('FORBIDDEN')
    expect(res.body.error.details).toMatchObject({ permission: 'billing.read', role: 'viewer', version: 3 })
  })

  it('answers FEATURE_DISABLED when the flag is off, even for an admin', async () => {
    cacheAccess(accessFor('admin', { flag: false }))
    const res = await request(app).get('/api/v1/orgs/org_lumen/prompts').set('Cookie', cookie).expect(403)
    expect(res.body.error).toMatchObject({ code: 'FEATURE_DISABLED', details: { flag: 'prompt_library' } })
  })

  it('answers ENTITLEMENT_REQUIRED when the plan lacks exports, even though the role may export', async () => {
    databaseSays('admin', { plan: 'starter' })
    const res = await request(app)
      .post('/api/v1/orgs/org_lumen/exports')
      .set('Cookie', cookie)
      .set('Idempotency-Key', 'export-key-1')
      .send({ kind: 'conversations', filters: {} })
      .expect(403)
    expect(res.body.error).toMatchObject({ code: 'ENTITLEMENT_REQUIRED', details: { entitlement: 'exports', plan: 'starter' } })
  })

  it('refuses writes while an admin previews as another role', async () => {
    session.preview = { orgId: 'org_lumen', role: 'viewer' }
    databaseSays('admin')
    const res = await request(app)
      .post('/api/v1/orgs/org_lumen/agents')
      .set('Cookie', cookie)
      .send({ name: 'x', model: 'relay-small', projectId: PROJECT })
      .expect(403)
    expect(res.body.error.code).toBe('READ_ONLY')
  })
})

describe('the permission cache', () => {
  it('serves reads from the cache without recomputing access', async () => {
    cacheAccess(accessFor('viewer'))
    query.mockResolvedValueOnce({ rows: [] }) // the agents list itself
    await request(app).get('/api/v1/orgs/org_lumen/agents').set('Cookie', cookie).expect(200)
    expect(query).toHaveBeenCalledTimes(1)
    expect(query.mock.calls[0][0]).toContain('FROM agents a')
  })

  it('never trusts the cache for a write: a demoted admin is refused at once', async () => {
    cacheAccess(accessFor('admin')) // stale: the role changed a moment ago
    databaseSays('viewer')
    const res = await request(app)
      .post('/api/v1/orgs/org_lumen/agents')
      .set('Cookie', cookie)
      .send({ name: 'Sneaky', model: 'relay-small', projectId: PROJECT })
      .expect(403)
    expect(res.body.error.details).toMatchObject({ permission: 'agents.write', role: 'viewer' })
  })

  it('ignores entries cached under an older version', async () => {
    cacheAccess(accessFor('admin', { version: 3 }))
    cache['authz:ver:org_lumen'] = '4' // a membership change bumped the version
    databaseSays('viewer', { version: 4 })
    const res = await request(app).get('/api/v1/orgs/org_lumen/billing').set('Cookie', cookie).expect(403)
    expect(res.body.error.details.role).toBe('viewer')
    expect(redis.set).toHaveBeenCalledWith('perm:org_lumen:u1:v4', expect.any(String), 'EX', 60)
  })
})

describe('resources are scoped inside the query', () => {
  it('passes the org and the accessible projects to PostgreSQL, and 404s when nothing matches', async () => {
    cacheAccess(accessFor('admin'))
    query.mockResolvedValueOnce({ rows: [] })
    const res = await request(app).get(`/api/v1/orgs/org_lumen/agents/${AGENT}`).set('Cookie', cookie).expect(404)
    expect(res.body.error.code).toBe('NOT_FOUND')
    const [sql, params] = query.mock.calls[0]
    expect(sql).toContain('a.org_id = $2 AND a.project_id = ANY($3::uuid[])')
    expect(params).toEqual([AGENT, 'org_lumen', [PROJECT]])
  })

  it('treats a malformed resource id as not found', async () => {
    cacheAccess(accessFor('admin'))
    await request(app).get('/api/v1/orgs/org_lumen/conversations/1%20OR%201=1').set('Cookie', cookie).expect(404)
    expect(query).not.toHaveBeenCalled()
  })

  it('rejects creating a resource in a project outside the caller’s access', async () => {
    databaseSays('editor')
    await request(app)
      .post('/api/v1/orgs/org_lumen/agents')
      .set('Cookie', cookie)
      .send({ name: 'x', model: 'relay-small', projectId: '11111111-1111-4111-8111-111111111111' })
      .expect(404)
  })
})

describe('share links', () => {
  it('404s an unknown token and 410s a revoked one', async () => {
    query.mockResolvedValueOnce({ rows: [] })
    await request(app).get('/api/v1/shared/unknown-token-0123456789').expect(404)
    query.mockResolvedValueOnce({
      rows: [{ id: 'l1', revoked_at: new Date(), expires_at: null, creator_is_member: true, title: 't', body: 'b' }],
    })
    const res = await request(app).get('/api/v1/shared/revoked-token-0123456789').expect(410)
    expect(res.body.error.code).toBe('LINK_REVOKED')
  })

  it('treats a link as revoked once its creator has left the org', async () => {
    query.mockResolvedValueOnce({
      rows: [{ id: 'l1', revoked_at: null, expires_at: null, creator_is_member: false, title: 't', body: 'b' }],
    })
    await request(app).get('/api/v1/shared/orphaned-token-0123456789').expect(410)
  })
})

describe('route inventory', () => {
  const orgRouters = [orgRouter, agentsRouter, conversationsRouter, promptsRouter, adminRouter, exportsRouter]

  type Layer = { route?: { path: string; methods: Record<string, boolean> }; name: string; handle: unknown; regexp: RegExp }

  it('registers every org-scoped route with an access rule', () => {
    for (const { router } of orgRouters) {
      for (const layer of (router as Router).stack as Layer[]) {
        if (!layer.route) continue
        for (const method of Object.keys(layer.route.methods)) {
          const entry = routeInventory.find(
            (r) => r.method === method.toUpperCase() && r.path === `${ORG_BASE}${layer.route!.path}`,
          )
          expect(entry, `${method.toUpperCase()} ${layer.route.path} has no access rule`).toBeDefined()
          expect(entry!.permission).toBeTruthy()
        }
      }
    }
    expect(routeInventory.length).toBeGreaterThan(30)
  })

  it('mounts nothing under /api/v1/orgs/:orgId except those routers', () => {
    const known = new Set(orgRouters.map((r) => r.router as unknown))
    const stack = (app as unknown as { _router: { stack: Layer[] } })._router.stack
    const orgLayers = stack.filter((layer) => layer.regexp.test('/api/v1/orgs/org_lumen/anything'))
    // Global middleware and the 404 match every path. Routers mounted higher up (/api/v1) may match too,
    // but none of them may declare a route of their own under /orgs.
    for (const layer of orgLayers) {
      if (layer.name !== 'router' || known.has(layer.handle)) continue
      const routes = ((layer.handle as Router).stack as Layer[]).filter((l) => l.route).map((l) => l.route!.path)
      expect(routes.filter((path) => path.startsWith('/orgs'))).toEqual([])
    }
  })

  it('lists only management permissions on admin routes', () => {
    const settings = routeInventory.filter((r) => /\/(members|invitations|audit|features)/.test(r.path) && r.method !== 'GET')
    for (const r of settings) expect(['members.manage', 'features.manage']).toContain(r.permission)
  })
})
