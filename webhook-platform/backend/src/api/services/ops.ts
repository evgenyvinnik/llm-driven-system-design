/**
 * Operator view: fleet-wide queue depth, outbox lag, in-flight per endpoint
 * and success rate. No payloads.
 * @module api/services/ops
 */
import { config } from '../../shared/config.js'
import { redis } from '../../shared/cache.js'
import { pool } from '../../shared/db.js'
import { slotsInUse } from '../../shared/semaphore.js'

interface QueueInfo {
  name: string
  ready: number | null
  unacked: number | null
  consumers: number | null
  publishRate: number | null
  deliverRate: number | null
  redeliverRate: number | null
}

async function rabbitQueue(name: string): Promise<QueueInfo> {
  const url = new URL(config.rabbitMgmtUrl)
  const auth = Buffer.from(`${decodeURIComponent(url.username || 'guest')}:${decodeURIComponent(url.password || 'guest')}`).toString('base64')
  try {
    const res = await fetch(`${url.protocol}//${url.host}/api/queues/%2F/${encodeURIComponent(name)}`, {
      headers: { authorization: `Basic ${auth}` },
      signal: AbortSignal.timeout(1500),
    })
    if (!res.ok) throw new Error(String(res.status))
    const q = (await res.json()) as {
      messages_ready?: number
      messages_unacknowledged?: number
      consumers?: number
      message_stats?: { publish_details?: { rate: number }; deliver_get_details?: { rate: number }; redeliver_details?: { rate: number } }
    }
    return {
      name,
      ready: q.messages_ready ?? 0,
      unacked: q.messages_unacknowledged ?? 0,
      consumers: q.consumers ?? 0,
      publishRate: q.message_stats?.publish_details?.rate ?? 0,
      deliverRate: q.message_stats?.deliver_get_details?.rate ?? 0,
      redeliverRate: q.message_stats?.redeliver_details?.rate ?? 0,
    }
  } catch {
    return { name, ready: null, unacked: null, consumers: null, publishRate: null, deliverRate: null, redeliverRate: null }
  }
}

export async function opsOverview() {
  const [queue, poison, outbox, states, endpoints, orgs, minute] = await Promise.all([
    rabbitQueue(config.queue.deliveries),
    rabbitQueue(config.queue.poison),
    pool.query<{ unpublished: number; oldest_s: number | null }>(
      `SELECT count(*)::int AS unpublished, EXTRACT(EPOCH FROM now() - min(created_at))::float8 AS oldest_s FROM outbox WHERE published_at IS NULL`,
    ),
    pool.query<{ state: string; n: number }>(`SELECT state, count(*)::int AS n FROM deliveries GROUP BY state`),
    pool.query<{
      id: string
      org_name: string
      description: string
      url: string
      status: string
      max_concurrency: number
      consecutive_failures: number
      paused_until: Date | null
      in_flight: number
      queued: number
      scheduled: number
    }>(
      `SELECT e.id, o.name AS org_name, e.description, e.url, e.status, e.max_concurrency, e.consecutive_failures, e.paused_until,
              count(d.id) FILTER (WHERE d.state = 'in_flight')::int AS in_flight,
              count(d.id) FILTER (WHERE d.state = 'queued')::int AS queued,
              count(d.id) FILTER (WHERE d.state = 'scheduled')::int AS scheduled
         FROM endpoints e JOIN orgs o ON o.id = e.org_id
         LEFT JOIN deliveries d ON d.endpoint_id = e.id AND d.state IN ('in_flight', 'queued', 'scheduled')
        GROUP BY e.id, o.name ORDER BY o.name, e.created_at`,
    ),
    pool.query<{ org_name: string; attempts: number; ok: number; p50: number | null; p95: number | null; e2e_p50: number | null; e2e_p95: number | null }>(
      `SELECT o.name AS org_name,
              (SELECT count(*)::int FROM attempts a JOIN deliveries d ON d.id = a.delivery_id
                WHERE d.org_id = o.id AND a.started_at > now() - interval '5 minutes' AND a.outcome <> 'lost') AS attempts,
              (SELECT count(*)::int FROM attempts a JOIN deliveries d ON d.id = a.delivery_id
                WHERE d.org_id = o.id AND a.started_at > now() - interval '5 minutes' AND a.outcome = 'delivered') AS ok,
              (SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY a.latency_ms) FROM attempts a JOIN deliveries d ON d.id = a.delivery_id
                WHERE d.org_id = o.id AND a.started_at > now() - interval '5 minutes' AND a.outcome = 'delivered') AS p50,
              (SELECT percentile_cont(0.95) WITHIN GROUP (ORDER BY a.latency_ms) FROM attempts a JOIN deliveries d ON d.id = a.delivery_id
                WHERE d.org_id = o.id AND a.started_at > now() - interval '5 minutes' AND a.outcome = 'delivered') AS p95,
              (SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM d.delivered_at - d.created_at) * 1000) FROM deliveries d
                WHERE d.org_id = o.id AND d.delivered_at > now() - interval '5 minutes' AND d.replay_count = 0) AS e2e_p50,
              (SELECT percentile_cont(0.95) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM d.delivered_at - d.created_at) * 1000) FROM deliveries d
                WHERE d.org_id = o.id AND d.delivered_at > now() - interval '5 minutes' AND d.replay_count = 0) AS e2e_p95
         FROM orgs o ORDER BY o.name`,
    ),
    pool.query<{ attempts: number; ok: number }>(
      `SELECT count(*)::int AS attempts, count(*) FILTER (WHERE outcome = 'delivered')::int AS ok FROM attempts
        WHERE started_at > now() - interval '5 minutes' AND outcome <> 'lost'`,
    ),
  ])

  const slots = await Promise.all(endpoints.rows.map((e) => slotsInUse(redis, e.id).catch(() => null)))
  const now = Date.now()
  return {
    queue,
    poison,
    outbox: { unpublished: outbox.rows[0].unpublished, oldestSeconds: outbox.rows[0].oldest_s },
    deliveriesByState: Object.fromEntries(states.rows.map((r) => [r.state, r.n])),
    successRate5m: minute.rows[0].attempts > 0 ? minute.rows[0].ok / minute.rows[0].attempts : null,
    attempts5m: minute.rows[0].attempts,
    orgs: orgs.rows.map((o) => ({
      org: o.org_name,
      attempts5m: o.attempts,
      successRate5m: o.attempts > 0 ? o.ok / o.attempts : null,
      attemptP50Ms: o.p50 === null ? null : Math.round(o.p50),
      attemptP95Ms: o.p95 === null ? null : Math.round(o.p95),
      eventToDeliveredP50Ms: o.e2e_p50 === null ? null : Math.round(o.e2e_p50),
      eventToDeliveredP95Ms: o.e2e_p95 === null ? null : Math.round(o.e2e_p95),
    })),
    endpoints: endpoints.rows.map((e, i) => ({
      id: e.id,
      org: e.org_name,
      description: e.description,
      url: e.url,
      status: e.status,
      maxConcurrency: e.max_concurrency,
      effectiveConcurrency: e.consecutive_failures >= config.delivery.probeAfterFailures ? 1 : e.max_concurrency,
      consecutiveFailures: e.consecutive_failures,
      pausedUntil: e.paused_until && e.paused_until.getTime() > now ? e.paused_until.toISOString() : null,
      inFlight: e.in_flight,
      slotsHeld: slots[i],
      queued: e.queued,
      scheduled: e.scheduled,
    })),
    policy: {
      retryHorizonSeconds: config.delivery.retryHorizonSeconds,
      backoffBaseMs: config.delivery.backoffBaseMs,
      backoffCapMs: config.delivery.backoffCapMs,
      timeoutMs: config.delivery.timeoutMs,
      probeAfterFailures: config.delivery.probeAfterFailures,
    },
  }
}
