/**
 * The admin console's snapshot: queues per class and tenant (Valkey), backend
 * status as the dispatcher last saw it (Valkey), batch fill, usage per tenant
 * and the latency split (PostgreSQL), admission rejections (Valkey counters).
 * One read model assembled per poll; nothing here is on the request path.
 * @module gateway/admin-overview
 */
import { CLASSES, keys, minuteBucket, redis } from '../shared/cache.js'
import { pool } from '../shared/db.js'
import { getRuntimeConfig } from '../shared/runtime-config.js'
import { HashRing, membershipChange } from '../dispatcher/router.js'
import { config } from '../shared/config.js'

interface OrgRow {
  id: string
  name: string
  slug: string
  tier: string
}

async function orgsById(): Promise<Map<string, OrgRow>> {
  const { rows } = await pool.query<OrgRow>('SELECT id, name, slug, tier FROM orgs')
  return new Map(rows.map((r) => [r.id, r]))
}

export async function queuesView(orgs: Map<string, OrgRow>) {
  const now = Date.now()
  const rc = await getRuntimeConfig()
  return Promise.all(
    CLASSES.map(async (cls) => {
      const [depth, oldest, tenants] = await Promise.all([
        redis.zcard(keys.age(cls)),
        redis.zrange(keys.age(cls), 0, 0, 'WITHSCORES'),
        redis.smembers(keys.tenants(cls)),
      ])
      const lens = await Promise.all(tenants.map((t) => redis.llen(keys.tenantQueue(cls, t))))
      return {
        class: cls,
        depth,
        limit: cls === 'interactive' ? rc.interactiveQueueLimit : rc.batchQueueLimit,
        oldestWaitMs: oldest.length === 2 ? Math.max(0, now - Number(oldest[1])) : null,
        tenants: tenants
          .map((t, i) => ({ orgId: t, orgName: orgs.get(t)?.name ?? t, depth: lens[i] }))
          .filter((t) => t.depth > 0)
          .sort((a, b) => b.depth - a.depth),
      }
    }),
  )
}

export async function backendsView() {
  const raw = await redis.hgetall(keys.backends)
  return config.backends.map((b) => {
    const parsed = raw[b.id] ? (JSON.parse(raw[b.id]) as Record<string, unknown>) : null
    return parsed ?? { id: b.id, url: b.url, reachable: false, status: 'unknown' }
  })
}

async function batchesView() {
  const [recent, summary] = await Promise.all([
    pool.query(
      `SELECT id, priority_class, size, max_size, trigger, oldest_wait_ms, backends, created_at FROM batches ORDER BY created_at DESC LIMIT 60`,
    ),
    pool.query(
      `SELECT priority_class, trigger, count(*)::int AS n, avg(size::float / max_size) AS fill, avg(size)::float AS avg_size, avg(oldest_wait_ms)::float AS avg_wait
       FROM batches WHERE created_at > now() - interval '10 minutes' GROUP BY 1, 2 ORDER BY 1, 2`,
    ),
  ])
  return {
    recent: recent.rows.map((r) => ({
      id: r.id,
      priorityClass: r.priority_class,
      size: r.size,
      maxSize: r.max_size,
      trigger: r.trigger,
      oldestWaitMs: r.oldest_wait_ms,
      backends: r.backends,
      createdAt: r.created_at.toISOString(),
    })),
    summary: summary.rows.map((r) => ({
      priorityClass: r.priority_class,
      trigger: r.trigger,
      count: r.n,
      avgFill: Math.round(r.fill * 1000) / 1000,
      avgSize: Math.round(r.avg_size * 10) / 10,
      avgOldestWaitMs: Math.round(r.avg_wait),
    })),
  }
}

async function usageView(orgs: Map<string, OrgRow>) {
  const { rows } = await pool.query(
    `SELECT org_id, count(*)::int AS requests,
            count(*) FILTER (WHERE status = 'completed')::int AS completed,
            count(*) FILTER (WHERE status = 'cancelled')::int AS cancelled,
            count(*) FILTER (WHERE status = 'failed')::int AS failed,
            coalesce(sum(input_tokens), 0)::int AS input_tokens, coalesce(sum(cached_input_tokens), 0)::int AS cached_tokens,
            coalesce(sum(output_tokens), 0)::int AS output_tokens, coalesce(sum(refunded_tokens), 0)::int AS refunded_tokens,
            percentile_cont(0.5) WITHIN GROUP (ORDER BY queue_ms) AS p50_queue,
            percentile_cont(0.95) WITHIN GROUP (ORDER BY queue_ms) AS p95_queue,
            percentile_cont(0.5) WITHIN GROUP (ORDER BY ttft_ms) AS p50_ttft
     FROM usage WHERE created_at > now() - interval '60 minutes' GROUP BY org_id`,
  )
  const minute = minuteBucket()
  const statKeys = [...orgs.keys()].flatMap((id) => Array.from({ length: 60 }, (_, i) => ({ id, key: keys.stats(id, minute - i) })))
  const pipeline = redis.pipeline()
  for (const s of statKeys) pipeline.hgetall(s.key)
  const results = (await pipeline.exec()) ?? []
  const rejections = new Map<string, Record<string, number>>()
  results.forEach(([, value], i) => {
    const id = statKeys[i].id
    const acc = rejections.get(id) ?? {}
    for (const [k, v] of Object.entries((value as Record<string, string>) ?? {})) acc[k] = (acc[k] ?? 0) + Number(v)
    rejections.set(id, acc)
  })
  const byOrg = new Map(rows.map((r) => [r.org_id as string, r]))
  return [...orgs.values()]
    .map((o) => {
      const u = byOrg.get(o.id)
      const s = rejections.get(o.id) ?? {}
      return {
        orgId: o.id,
        orgName: o.name,
        tier: o.tier,
        requests: u?.requests ?? 0,
        completed: u?.completed ?? 0,
        cancelled: u?.cancelled ?? 0,
        failed: u?.failed ?? 0,
        inputTokens: u?.input_tokens ?? 0,
        cachedTokens: u?.cached_tokens ?? 0,
        outputTokens: u?.output_tokens ?? 0,
        refundedTokens: u?.refunded_tokens ?? 0,
        p50QueueMs: u?.p50_queue === null || u?.p50_queue === undefined ? null : Math.round(u.p50_queue),
        p95QueueMs: u?.p95_queue === null || u?.p95_queue === undefined ? null : Math.round(u.p95_queue),
        p50TtftMs: u?.p50_ttft === null || u?.p50_ttft === undefined ? null : Math.round(u.p50_ttft),
        admitted: s.admitted ?? 0,
        rateLimited: (s.rate_limited_tokens ?? 0) + (s.rate_limited_requests ?? 0) + (s.tenant_queue_full ?? 0),
        overloaded: s.overloaded ?? 0,
      }
    })
    .sort((a, b) => b.requests + b.rateLimited - (a.requests + a.rateLimited))
}

async function latencyView() {
  const { rows } = await pool.query(
    `SELECT priority_class, count(*)::int AS n,
            percentile_cont(0.5) WITHIN GROUP (ORDER BY queue_ms) AS q50, percentile_cont(0.95) WITHIN GROUP (ORDER BY queue_ms) AS q95,
            percentile_cont(0.5) WITHIN GROUP (ORDER BY ttft_ms) AS t50, percentile_cont(0.95) WITHIN GROUP (ORDER BY ttft_ms) AS t95,
            percentile_cont(0.5) WITHIN GROUP (ORDER BY total_ms) AS total50, avg(tokens_per_sec) AS tps
     FROM usage WHERE created_at > now() - interval '5 minutes' AND status = 'completed' GROUP BY 1`,
  )
  const r = (v: unknown) => (v === null || v === undefined ? null : Math.round(Number(v)))
  return rows.map((x) => ({
    priorityClass: x.priority_class,
    count: x.n,
    queueP50Ms: r(x.q50),
    queueP95Ms: r(x.q95),
    ttftP50Ms: r(x.t50),
    ttftP95Ms: r(x.t95),
    totalP50Ms: r(x.total50),
    tokensPerSec: x.tps === null ? null : Math.round(Number(x.tps) * 10) / 10,
  }))
}

export async function adminOverview() {
  const orgs = await orgsById()
  const [queues, backends, batches, usage, latency, runtimeConfig, leader, inflight, open] = await Promise.all([
    queuesView(orgs),
    backendsView(),
    batchesView(),
    usageView(orgs),
    latencyView(),
    getRuntimeConfig(0),
    redis.get(keys.leader),
    redis.zcard(keys.inflight),
    pool.query(`SELECT priority_class, status, count(*)::int AS n FROM requests WHERE status IN ('queued','running') GROUP BY 1, 2`),
  ])
  return {
    generatedAt: new Date().toISOString(),
    queues,
    backends,
    batches,
    usage,
    latency,
    config: runtimeConfig,
    dispatcher: { leader, inflight },
    open: open.rows.map((r) => ({ priorityClass: r.priority_class, status: r.status, count: r.n })),
  }
}

/** Ring shares and what adding or removing a backend would move, plus observed affinity. */
export async function routingView() {
  const ids = config.backends.map((b) => b.id)
  const sample = Array.from({ length: 10_000 }, (_, i) => `sample-prefix-${i}`)
  const ring = new HashRing(ids, config.dispatcher.virtualNodes)
  const shares: Record<string, number> = Object.fromEntries(ids.map((id) => [id, 0]))
  for (const k of sample) shares[ring.owner(k) as string]++
  const nextId = `b${ids.length + 1}`
  const add = membershipChange(ids, [...ids, nextId], sample, config.dispatcher.virtualNodes)
  const remove = membershipChange(ids, ids.slice(0, -1), sample, config.dispatcher.virtualNodes)
  const { rows: observed } = await pool.query(
    `SELECT coalesce(r.affinity, 'unknown') AS affinity, count(*)::int AS n,
            count(*) FILTER (WHERE u.cached_input_tokens > 0)::int AS hits,
            avg(u.ttft_ms) FILTER (WHERE u.cached_input_tokens > 0) AS ttft_hit,
            avg(u.ttft_ms) FILTER (WHERE u.cached_input_tokens = 0) AS ttft_miss
     FROM requests r JOIN usage u ON u.request_id = r.id
     WHERE u.created_at > now() - interval '15 minutes' AND u.ttft_ms IS NOT NULL GROUP BY 1`,
  )
  const { rows: prefixes } = await pool.query(
    `SELECT r.prefix_key, count(*)::int AS n, count(DISTINCT r.backend_id)::int AS backends, mode() WITHIN GROUP (ORDER BY r.backend_id) AS main_backend,
            avg(u.ttft_ms) AS ttft
     FROM requests r JOIN usage u ON u.request_id = r.id
     WHERE u.created_at > now() - interval '15 minutes' AND u.ttft_ms IS NOT NULL
     GROUP BY 1 ORDER BY n DESC LIMIT 8`,
  )
  return {
    backends: ids,
    virtualNodes: config.dispatcher.virtualNodes,
    epsilon: config.dispatcher.loadEpsilon,
    lowLoadFraction: config.dispatcher.lowLoadFraction,
    shares: Object.fromEntries(Object.entries(shares).map(([id, n]) => [id, n / sample.length])),
    add: { backend: nextId, ...add },
    remove: { backend: ids[ids.length - 1], ...remove },
    observed: observed.map((o) => ({
      affinity: o.affinity,
      count: o.n,
      cacheHits: o.hits,
      ttftHitMs: o.ttft_hit === null ? null : Math.round(Number(o.ttft_hit)),
      ttftMissMs: o.ttft_miss === null ? null : Math.round(Number(o.ttft_miss)),
    })),
    prefixes: prefixes.map((p) => ({
      prefixKey: p.prefix_key,
      requests: p.n,
      backends: p.backends,
      mainBackend: p.main_backend,
      owner: ring.owner(p.prefix_key),
      avgTtftMs: p.ttft === null ? null : Math.round(Number(p.ttft)),
    })),
  }
}
