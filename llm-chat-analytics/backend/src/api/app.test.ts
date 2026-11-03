import request from 'supertest'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// ─── Mocks: an in-memory Valkey, canned PostgreSQL rows, canned ClickHouse aggregates ───

const store = new Map<string, string>()
const hashes = new Map<string, Record<string, string>>()

vi.mock('../shared/cache.js', async () => {
  const { keys } = await import('../shared/keys.js')
  const redis = {
    get: async (k: string) => store.get(k) ?? null,
    set: async (k: string, v: string) => {
      store.set(k, v)
      return 'OK'
    },
    del: async (k: string) => (store.delete(k) ? 1 : 0),
    hgetall: async (k: string) => hashes.get(k) ?? {},
    hmget: async (k: string, ...fields: string[]) => fields.map((f) => hashes.get(k)?.[f] ?? null),
    ping: async () => 'PONG',
  }
  return { redis, keys, createRedisConnection: () => redis }
})

const ORGS = { larkspur: { id: 'larkspur', name: 'Larkspur Labs', time_zone: 'America/Los_Angeles' } }
const MEMBERSHIPS: Record<string, { role: 'admin' | 'analyst' }> = { '1': { role: 'admin' }, '2': { role: 'analyst' } }

vi.mock('../shared/db.js', () => ({
  pool: {
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      if (sql.includes('FROM memberships')) {
        const m = MEMBERSHIPS[String(params[0])]
        return { rows: m ? [{ ...ORGS.larkspur, role: m.role }] : [] }
      }
      if (sql.includes('FROM orgs ORDER BY name')) return { rows: [ORGS.larkspur] }
      return { rows: [] }
    }),
  },
}))

const aggregateRow = {
  conversations: 120,
  messages: 400,
  responses_ok: 380,
  responses_failed: 10,
  responses_abandoned: 10,
  input_tokens: 500_000,
  output_tokens: 120_000,
  cost_micros: 2_340_000,
  late_events: 0,
  last_revised_at: '1970-01-01 00:00:00.000',
  active_users: 80,
  ttft: [500, 2400, 4100],
  latency: [3000, 9000, 15000],
}
const chQuery = vi.fn(async () => [aggregateRow])

vi.mock('../shared/clickhouse.js', () => ({
  chQuery: (...args: unknown[]) => chQuery(...(args as [])),
  clickhouse: { ping: async () => ({ success: true }) },
  ensureClickHouseSchema: async () => undefined,
}))

const { createApp } = await import('./app.js')
const app = createApp()

function session(id: string, user: object) {
  store.set(`session:${id}`, JSON.stringify(user))
  return `lca_session=${id}`
}

const ADMIN = () => session('s-alice', { id: '1', username: 'alice', displayName: 'Alice', isStaff: false })
const ANALYST = () => session('s-bob', { id: '2', username: 'bob', displayName: 'Bob', isStaff: false })
const SUPPORT = () => session('s-dana', { id: '4', username: 'dana', displayName: 'Dana', isStaff: true })
const OUTSIDER = () => session('s-eve', { id: '9', username: 'eve', displayName: 'Eve', isStaff: false })

// Oct 5–12, 2026 in Los Angeles (PDT, UTC-7): local-midnight aligned.
const Q = 'org=larkspur&from=2026-10-05T07:00:00.000Z&to=2026-10-12T07:00:00.000Z&grain=day'

beforeEach(() => {
  store.clear()
  hashes.clear()
  const now = Date.now()
  hashes.set('ingest:positions', Object.fromEntries([0, 1, 2].map((p) => [String(p), JSON.stringify({ position: now, updatedAt: now, lag: 0 })])))
  chQuery.mockClear()
})

describe('role-gated metrics', () => {
  it('leaves cost out of the overview for an analyst: absent, not hidden', async () => {
    const res = await request(app).get(`/api/v1/query/overview?${Q}`).set('Cookie', ANALYST())
    expect(res.status).toBe(200)
    expect(res.body.tiles.map((t: { id: string }) => t.id)).not.toContain('cost_usd')
    expect(JSON.stringify(res.body)).not.toMatch(/cost/i)
  })

  it('includes cost for an org admin', async () => {
    const res = await request(app).get(`/api/v1/query/overview?${Q}`).set('Cookie', ADMIN())
    const cost = res.body.tiles.find((t: { id: string }) => t.id === 'cost_usd')
    expect(cost.value).toBeCloseTo(2.34)
  })

  it('never serves an analyst the admin’s cached response for the same query', async () => {
    const first = await request(app).get(`/api/v1/query/overview?${Q}`).set('Cookie', ADMIN())
    expect(first.body.cache).toBe('miss')
    const again = await request(app).get(`/api/v1/query/overview?${Q}`).set('Cookie', ADMIN())
    expect(again.body.cache).toBe('hit')
    const analyst = await request(app).get(`/api/v1/query/overview?${Q}`).set('Cookie', ANALYST())
    expect(analyst.body.cache).toBe('miss')
    expect(JSON.stringify(analyst.body)).not.toMatch(/cost/i)
  })

  it('refuses a billing metric outright, without querying ClickHouse', async () => {
    const res = await request(app).get(`/api/v1/query/series?${Q}&metric=cost_usd`).set('Cookie', ANALYST())
    expect(res.status).toBe(403)
    expect(res.body.error.code).toBe('METRIC_FORBIDDEN')
    expect(chQuery).not.toHaveBeenCalled()
  })

  it('lets support staff see health but not conversations', async () => {
    expect((await request(app).get(`/api/v1/query/series?${Q}&metric=error_rate`).set('Cookie', SUPPORT())).status).toBe(200)
    const drill = await request(app).get(`/api/v1/query/drilldown?${Q}&metric=conversations&bucket=2026-10-06T07:00:00.000Z`).set('Cookie', SUPPORT())
    expect(drill.status).toBe(403)
  })

  it('answers 404 for an org the user does not belong to', async () => {
    const res = await request(app).get(`/api/v1/query/overview?${Q}`).set('Cookie', OUTSIDER())
    expect(res.status).toBe(404)
  })
})

describe('query validation and echo', () => {
  it('rejects a day range that is not aligned to local midnight in the org zone', async () => {
    const res = await request(app)
      .get('/api/v1/query/overview?org=larkspur&from=2026-10-05T00:00:00.000Z&to=2026-10-12T00:00:00.000Z&grain=day')
      .set('Cookie', ADMIN())
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('UNALIGNED_RANGE')
  })

  it('echoes one canonical string for equivalent queries', async () => {
    const a = await request(app).get(`/api/v1/query/series?${Q}&metric=conversations&models=orion-swift,orion-large`).set('Cookie', ADMIN())
    const b = await request(app).get(`/api/v1/query/series?${Q}&metric=conversations&models=orion-large,orion-swift,orion-large`).set('Cookie', ADMIN())
    expect(a.body.echo).toBe(b.body.echo)
    expect(a.body.echo).toContain('models=orion-large,orion-swift')
    expect(b.body.cache).toBe('hit')
  })

  it('suppresses narrowed buckets with fewer than five users', async () => {
    chQuery.mockImplementation(async () => [{ ...aggregateRow, k: '2026-10-06', active_users: 3 }])
    const res = await request(app).get(`/api/v1/query/series?${Q}&metric=messages&features=image_input`).set('Cookie', ADMIN())
    const bucket = res.body.buckets.find((b: { key: string }) => b.key === '2026-10-06')
    expect(bucket.suppressed).toBe(true)
    expect(bucket.value).toBeNull()
    expect(bucket.count).toBe(0)
    chQuery.mockImplementation(async () => [aggregateRow])
  })

  it('suppresses the comparison period and the tiles by the same rule', async () => {
    // Three users on every day of both the current and the previous week.
    const days = Array.from({ length: 15 }, (_, i) => new Date(Date.UTC(2026, 8, 28 + i)).toISOString().slice(0, 10))
    chQuery.mockImplementation(async () => days.map((k) => ({ ...aggregateRow, k, active_users: 3 })))
    const series = await request(app).get(`/api/v1/query/series?${Q}&metric=messages&features=image_input&compare=wow`).set('Cookie', ADMIN())
    expect(series.body.buckets.every((b: { previous: { value: unknown } }) => b.previous.value === null)).toBe(true)
    const overview = await request(app).get(`/api/v1/query/overview?${Q}&features=image_input&compare=wow`).set('Cookie', ADMIN())
    expect(overview.body.suppressed).toBe(true)
    expect(overview.body.tiles.every((t: { value: unknown; previous: unknown }) => t.value === null && t.previous === null)).toBe(true)
    chQuery.mockImplementation(async () => [aggregateRow])
  })

  it('refuses to split conversations by feature instead of answering 0', async () => {
    const res = await request(app).get(`/api/v1/query/series?${Q}&metric=conversations&features=code_execution`).set('Cookie', ADMIN())
    expect(res.status).toBe(422)
    expect(res.body.error.code).toBe('DIMENSION_NOT_APPLICABLE')
    const overview = await request(app).get(`/api/v1/query/overview?${Q}&features=code_execution`).set('Cookie', ADMIN())
    const tile = overview.body.tiles.find((t: { id: string }) => t.id === 'conversations')
    expect(tile).toMatchObject({ value: null, notApplicable: 'feature' })
    expect(overview.body.tiles.find((t: { id: string }) => t.id === 'active_users').value).toBe(80)
  })
})
