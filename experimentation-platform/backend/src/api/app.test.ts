/**
 * Route-level tests with the shared infrastructure mocked: access control,
 * snapshot ETags and 304s, ingest batch dedup (including beacon bodies), and
 * server-key-only endpoints.
 */
import request from 'supertest'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const store = new Map<string, string>()
const enqueued: string[] = []

vi.mock('../shared/cache.js', () => {
  const redis = {
    get: vi.fn(async (k: string) => store.get(k) ?? null),
    set: vi.fn(async (k: string, v: string) => {
      store.set(k, v)
      return 'OK'
    }),
    del: vi.fn(async () => 1),
    incr: vi.fn(async () => 1),
    expire: vi.fn(async () => 1),
    hget: vi.fn(async () => null),
    hset: vi.fn(async () => 1),
    hgetall: vi.fn(async () => ({})),
    hdel: vi.fn(async () => 1),
    ping: vi.fn(async () => 'PONG'),
    // The ingest Lua script: SET NX the batch key, then XADD.
    eval: vi.fn(async (_script: string, _n: number, batchKey: string, _stream: string, _ttl: string, _max: string, payload: string) => {
      if (store.has(batchKey)) return null
      store.set(batchKey, '1')
      enqueued.push(payload)
      return `${enqueued.length}-0`
    }),
  }
  const keys = {
    session: (id: string) => `exp:session:${id}`,
    shopSession: (id: string) => `exp:shop-session:${id}`,
    rate: (b: string) => `exp:rate:${b}`,
    snapshotLatest: (e: string) => `exp:snapshot:${e}:latest`,
    snapshotPublishedAt: (e: string, v: number) => `exp:snapshot:${e}:published:${v}`,
    snapshotChannel: 'exp:snapshots',
    eventStream: 'exp:events',
    eventGroup: 'ingest',
    batchSeen: (e: string, b: string) => `exp:batch:${e}:${b}`,
    clients: (e: string) => `exp:clients:${e}`,
    streams: (e: string) => `exp:streams:${e}`,
    alias: (e: string, u: string) => `exp:alias:${e}:${u}`,
    workerHeartbeat: 'exp:worker:heartbeat',
  }
  return { redis, keys, createRedisConnection: () => redis }
})

vi.mock('../shared/db.js', () => ({ pool: { query: vi.fn(async () => ({ rows: [], rowCount: 0 })) }, withTransaction: vi.fn() }))
vi.mock('../shared/clickhouse.js', () => ({ clickhouse: { ping: vi.fn(async () => ({ success: true })) }, chQuery: vi.fn(async () => []), chInsert: vi.fn() }))

vi.mock('../services/environment-service.js', () => {
  const envs = [{ key: 'prod', name: 'Production', clientKey: 'cli_prod_test', serverKey: 'srv_prod_test', snapshotVersion: 7 }]
  return {
    listEnvironments: vi.fn(async () => envs),
    environmentForClientKey: vi.fn(async (k?: string) => envs.find((e) => e.clientKey === k) ?? null),
    environmentForServerKey: vi.fn(async (k?: string) => envs.find((e) => e.serverKey === k) ?? null),
    environmentExists: vi.fn(async (k: string) => envs.some((e) => e.key === k)),
    clearEnvironmentCache: vi.fn(),
  }
})

const snapshotBody = {
  schema: 1,
  environment: 'prod',
  version: 7,
  compiledAt: '2026-11-06T00:00:00.000Z',
  flags: {
    checkout_cta: {
      key: 'checkout_cta',
      kind: 'experiment',
      unitType: 'user',
      salt: 's',
      status: 'running',
      version: 2,
      variants: [{ key: 'control', name: 'C' }, { key: 'treatment', name: 'T' }],
      defaultVariant: 'control',
      rules: [],
      fallthrough: 'enroll',
      allocation: { control: [[0, 5000]], treatment: [[5000, 10000]] },
    },
  },
}
vi.mock('../services/snapshot-service.js', () => {
  const snap = { environment: 'prod', version: 7, etag: '"prod-v7"', body: snapshotBody, json: JSON.stringify(snapshotBody) }
  return {
    getLatest: vi.fn(async () => snap),
    getByVersion: vi.fn(async (_e: string, v: number) => (v === 7 ? snap : null)),
    listSnapshots: vi.fn(async () => []),
    onSnapshot: vi.fn(() => () => undefined),
  }
})

vi.mock('../services/identity-service.js', () => ({
  linkIdentity: vi.fn(async (_e: string, _u: string, anon: string) => ({ stableId: anon, created: true })),
  resolveStableId: vi.fn(async () => 'anon-first'),
}))

const killSwitch = vi.fn(async () => ({ flag: {}, snapshotVersion: 8, publishedAt: Date.now() }))
vi.mock('../services/flag-service.js', () => ({
  listFlags: vi.fn(async () => []),
  getFlag: vi.fn(),
  createFlag: vi.fn(),
  updateMetadata: vi.fn(),
  updateConfig: vi.fn(),
  transitionStatus: vi.fn(),
  killSwitch,
  listVersions: vi.fn(async () => []),
  listAudit: vi.fn(async () => []),
  allocationsByVersion: vi.fn(),
}))

const { createApp } = await import('./app.js')
const app = createApp()

function session(role: 'admin' | 'viewer' | 'shopper') {
  const id = `sess-${role}`
  store.set(`exp:session:${id}`, JSON.stringify({ id: `u-${role}`, username: role, displayName: role, role }))
  return `exp_session=${id}`
}

beforeEach(() => {
  killSwitch.mockClear()
})

describe('console access control', () => {
  it('requires a session', async () => {
    const res = await request(app).get('/api/v1/flags')
    expect(res.status).toBe(401)
  })

  it('lets a viewer read but not pull the kill switch', async () => {
    expect((await request(app).get('/api/v1/flags').set('Cookie', session('viewer'))).status).toBe(200)
    const res = await request(app).post('/api/v1/flags/checkout_cta/environments/prod/kill').set('Cookie', session('viewer')).send({ reason: 'test' })
    expect(res.status).toBe(403)
    expect(res.body.error.code).toBe('FORBIDDEN')
    expect(killSwitch).not.toHaveBeenCalled()
  })

  it('lets an admin pull the kill switch, with a reason', async () => {
    expect((await request(app).post('/api/v1/flags/checkout_cta/environments/prod/kill').set('Cookie', session('admin')).send({})).status).toBe(422)
    const res = await request(app).post('/api/v1/flags/checkout_cta/environments/prod/kill').set('Cookie', session('admin')).send({ reason: 'checkout errors' })
    expect(res.status).toBe(200)
    expect(killSwitch).toHaveBeenCalledWith({ id: 'u-admin', username: 'admin' }, 'checkout_cta', 'prod', 'checkout errors')
  })

  it('keeps shoppers out of the console and hides server keys from viewers', async () => {
    expect((await request(app).get('/api/v1/flags').set('Cookie', session('shopper'))).status).toBe(403)
    const viewer = await request(app).get('/api/v1/environments').set('Cookie', session('viewer'))
    expect(viewer.body.environments[0]).toMatchObject({ clientKey: 'cli_prod_test', serverKey: null })
    const admin = await request(app).get('/api/v1/environments').set('Cookie', session('admin'))
    expect(admin.body.environments[0].serverKey).toBe('srv_prod_test')
  })
})

describe('snapshot delivery', () => {
  it('serves the snapshot with an ETag and answers 304 when it matches', async () => {
    const first = await request(app).get('/sdk/v1/snapshot').set('X-Client-Key', 'cli_prod_test')
    expect(first.status).toBe(200)
    expect(first.headers.etag).toBe('"prod-v7"')
    expect(first.headers['cache-control']).toBe('no-cache')
    expect(first.body.version).toBe(7)
    const again = await request(app).get('/sdk/v1/snapshot').set('X-Client-Key', 'cli_prod_test').set('If-None-Match', '"prod-v7"')
    expect(again.status).toBe(304)
    const stale = await request(app).get('/sdk/v1/snapshot').set('X-Client-Key', 'cli_prod_test').set('If-None-Match', '"prod-v6"')
    expect(stale.status).toBe(200)
  })

  it('serves immutable versions with a long cache lifetime, 404 for unknown ones', async () => {
    const res = await request(app).get('/sdk/v1/snapshots/7').set('X-Client-Key', 'cli_prod_test')
    expect(res.status).toBe(200)
    expect(res.headers['cache-control']).toContain('immutable')
    expect((await request(app).get('/sdk/v1/snapshots/3').set('X-Client-Key', 'cli_prod_test')).status).toBe(404)
  })

  it('rejects unknown client keys', async () => {
    expect((await request(app).get('/sdk/v1/snapshot').set('X-Client-Key', 'nope')).status).toBe(401)
  })
})

describe('ingest', () => {
  const event = (n: number) => ({
    type: 'exposure',
    eventId: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
    ts: Date.now() - 1000,
    flagKey: 'checkout_cta',
    flagVersion: 2,
    variant: 'treatment',
    unitType: 'user',
    unitId: 'anon-1',
  })

  it('accepts a batch once; a retry with the same batch id is acknowledged as a duplicate and not enqueued', async () => {
    const body = { batchId: 'batch-dedup-1', sentAt: Date.now(), events: [event(1), event(2)] }
    const first = await request(app).post('/sdk/v1/events').set('X-Client-Key', 'cli_prod_test').send(body)
    expect(first.status).toBe(202)
    expect(first.body).toMatchObject({ accepted: 2, duplicate: false })
    const before = enqueued.length
    const retry = await request(app).post('/sdk/v1/events').set('X-Client-Key', 'cli_prod_test').send(body)
    expect(retry.body).toMatchObject({ accepted: 0, duplicate: true })
    expect(enqueued.length).toBe(before)
  })

  it('accepts sendBeacon bodies (text/plain JSON with the client key inside)', async () => {
    const body = JSON.stringify({ batchId: 'batch-beacon-1', sentAt: Date.now(), clientKey: 'cli_prod_test', events: [event(3)] })
    const res = await request(app).post('/sdk/v1/events?key=cli_prod_test').set('Content-Type', 'text/plain').send(body)
    expect(res.status).toBe(202)
    expect(res.body.accepted).toBe(1)
  })

  it('counts invalid events as rejected without failing the batch', async () => {
    const res = await request(app)
      .post('/sdk/v1/events')
      .set('X-Client-Key', 'cli_prod_test')
      .send({ batchId: 'batch-mixed-1', sentAt: Date.now(), events: [event(4), { type: 'exposure', eventId: 'x' }] })
    expect(res.body).toMatchObject({ accepted: 1, rejected: 1 })
  })
})

describe('server-key endpoints', () => {
  it('identify and evaluate need the server key; the client key is not enough', async () => {
    expect((await request(app).post('/sdk/v1/identify').set('X-Server-Key', 'cli_prod_test').send({ userId: 'u', anonymousId: 'a' })).status).toBe(401)
    const ok = await request(app).post('/sdk/v1/identify').set('X-Server-Key', 'srv_prod_test').send({ userId: 'u', anonymousId: 'anon-1' })
    expect(ok.body).toEqual({ stableId: 'anon-1', created: true })
  })

  it('evaluate resolves a signed-in user to their stable id before bucketing', async () => {
    const res = await request(app).post('/sdk/v1/evaluate').set('X-Server-Key', 'srv_prod_test').send({ context: { userId: 'user-9' } })
    expect(res.status).toBe(200)
    expect(res.body.stableId).toBe('anon-first')
    expect(res.body.evaluations.checkout_cta.unitId).toBe('anon-first')
  })
})
