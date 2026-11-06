/**
 * Operations: stream and consumer-group health, the outbox backlog, projection
 * staleness, gateway watermarks, the dead-letter queue (list, redrive,
 * discard), sensor registration and projection replay.
 * @module api/services/ops
 */
import { z } from 'zod'
import type { SessionUser } from '../../shared/auth.js'
import { redis } from '../../shared/cache.js'
import { pool } from '../../shared/db.js'
import { HttpError, notFound } from '../../shared/errors.js'
import { dlqDepth } from '../../shared/metrics.js'
import { DLQ_KEY, DLQ_STATUS_KEY, describeTopics, fieldsToObject, TOPICS } from '../../shared/streams.js'
import { segmentAt, subdivisionAt } from '../../shared/track.js'
import { PROJECTIONS, projectionByName } from '../../projector/projections.js'
import { rebuildProjection } from '../../projector/store.js'

export interface DeadLetter {
  id: string
  key: string
  topic: string
  group: string
  messageId: string
  eventId: string
  type: string
  code: string
  permanent: boolean
  error: string
  deliveries: number
  failedAt: string
  event: unknown
  status: 'dead' | 'redriven' | 'discarded'
  resolvedBy: string | null
  resolvedAt: string | null
}

async function statusMap(): Promise<Record<string, { status: DeadLetter['status']; by: string; at: string }>> {
  const raw = await redis.hgetall(DLQ_STATUS_KEY)
  return Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, JSON.parse(v)]))
}

export async function deadLetters(): Promise<DeadLetter[]> {
  const entries = (await redis.xrevrange(DLQ_KEY, '+', '-', 'COUNT', 200)) as Array<[string, string[]]>
  const statuses = await statusMap()
  const out = entries.map(([id, fields]) => {
    const f = fieldsToObject(fields)
    let event: unknown = f.event
    try {
      event = JSON.parse(f.event)
    } catch {
      /* keep raw */
    }
    const s = statuses[id]
    return {
      id,
      key: f.key,
      topic: f.topic,
      group: f.group,
      messageId: f.messageId,
      eventId: f.eventId,
      type: f.type,
      code: f.code,
      permanent: f.permanent === '1',
      error: f.error,
      deliveries: Number(f.deliveries),
      failedAt: f.failedAt,
      event,
      status: s?.status ?? 'dead',
      resolvedBy: s?.by ?? null,
      resolvedAt: s?.at ?? null,
    } satisfies DeadLetter
  })
  dlqDepth.set(out.filter((d) => d.status === 'dead').length)
  return out
}

async function loadEntry(id: string): Promise<Record<string, string>> {
  const entries = (await redis.xrange(DLQ_KEY, id, id)) as Array<[string, string[]]>
  if (!entries[0]) throw notFound('Dead letter')
  const status = await redis.hget(DLQ_STATUS_KEY, id)
  if (status && JSON.parse(status).status !== 'dead') throw new HttpError(409, 'ALREADY_RESOLVED', `Dead letter ${id} was already ${JSON.parse(status).status}`)
  return fieldsToObject(entries[0][1])
}

/**
 * Re-publishes the original message, unchanged (same event id), to its
 * original partition. Every group on that partition sees it again; groups that
 * already processed it skip it by event id, so only the group that failed acts.
 */
export async function redrive(id: string, user: SessionUser): Promise<{ redrivenTo: string }> {
  const f = await loadEntry(id)
  await redis.xadd(f.key, '*', 'event', f.event, 'eventId', f.eventId, 'type', f.type, 'redriveOf', id)
  await redis.hset(DLQ_STATUS_KEY, id, JSON.stringify({ status: 'redriven', by: user.username, at: new Date().toISOString() }))
  return { redrivenTo: f.key }
}

export async function discard(id: string, user: SessionUser): Promise<void> {
  await loadEntry(id)
  await redis.hset(DLQ_STATUS_KEY, id, JSON.stringify({ status: 'discarded', by: user.username, at: new Date().toISOString() }))
}

export const registerSensorSchema = z.object({
  id: z.string().regex(/^(GEO|FNC|CAM|RTS|WTR)-\d{3}\.\d$/, 'Sensor ids look like GEO-118.9'),
  type: z.enum(['geophone', 'slide_fence', 'camera', 'rail_temp', 'water_level']),
  milepost: z.number(),
  neutralTempF: z.number().optional(),
  label: z.string().max(80).optional(),
})

export async function registerSensor(input: z.infer<typeof registerSensorSchema>, user: SessionUser) {
  const sub = subdivisionAt(input.milepost)
  const seg = sub && segmentAt(sub.id, input.milepost)
  if (!sub || !seg) throw new HttpError(422, 'OFF_LINE', `MP ${input.milepost} is not on the railroad`)
  const { rows } = await pool.query(
    `INSERT INTO sensors (id, type, subdivision_id, segment_id, milepost, gateway_id, neutral_temp_f, label, registered_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (id) DO NOTHING RETURNING id`,
    [input.id, input.type, sub.id, seg.id, input.milepost, seg.gatewayId, input.neutralTempF ?? null, input.label ?? null, user.username],
  )
  return { id: input.id, segmentId: seg.id, created: rows.length > 0 }
}

export async function replay(name: string) {
  const projection = projectionByName(name)
  if (!projection) throw new HttpError(404, 'UNKNOWN_PROJECTION', `Projections: ${PROJECTIONS.map((p) => p.name).join(', ')}`)
  return rebuildProjection(projection)
}

export async function overview() {
  const [groups, outbox, projections, gateways, rates, dlq, processed] = await Promise.all([
    describeTopics(redis, TOPICS),
    pool.query<{ lane: string; n: number; oldest_s: number | null }>(
      `SELECT lane, count(*)::int AS n, EXTRACT(EPOCH FROM (now() - min(created_at)))::float AS oldest_s FROM outbox WHERE published_at IS NULL GROUP BY lane`,
    ),
    pool.query(
      `SELECT c.projection, c.last_position, c.last_recorded_at, c.events_applied, c.rebuilt_at, c.updated_at,
         GREATEST(0, EXTRACT(EPOCH FROM ((SELECT max(recorded_at) FROM events) - c.last_recorded_at)))::float AS staleness_s,
         (SELECT count(*) FROM events e WHERE e.global_position > c.last_position)::int AS events_after
       FROM projection_checkpoints c ORDER BY c.projection`,
    ),
    pool.query(
      `SELECT gateway_id, segment_id, last_seen_at, reported_watermark, effective_watermark, buffered_count, last_seq, batches, events_accepted, duplicates, coverage,
         EXTRACT(EPOCH FROM (now() - last_seen_at))::float AS silent_s, EXTRACT(EPOCH FROM (now() - effective_watermark))::float AS watermark_lag_s
       FROM gateway_state ORDER BY gateway_id`,
    ),
    pool.query<{ edge_1m: number; domain_1m: number; edge_total: number; domain_total: number; late_1m: number }>(
      `SELECT (SELECT count(*) FROM edge_events WHERE recorded_at > now() - interval '1 minute')::int AS edge_1m,
              (SELECT count(*) FROM events WHERE recorded_at > now() - interval '1 minute')::int AS domain_1m,
              (SELECT count(*) FROM edge_events)::int AS edge_total,
              (SELECT count(*) FROM events)::int AS domain_total,
              (SELECT count(*) FROM edge_events WHERE late AND recorded_at > now() - interval '1 minute')::int AS late_1m`,
    ),
    deadLetters(),
    pool.query<{ consumer: string; n: number }>('SELECT consumer, count(*)::int AS n FROM processed_events GROUP BY consumer ORDER BY consumer'),
  ])
  return {
    groups,
    outbox: outbox.rows.map((r) => ({ lane: r.lane, unpublished: r.n, oldestSeconds: r.oldest_s })),
    projections: projections.rows.map((p) => ({
      projection: p.projection,
      lastPosition: p.last_position,
      eventsApplied: p.events_applied,
      lastRecordedAt: p.last_recorded_at,
      rebuiltAt: p.rebuilt_at,
      stalenessSeconds: p.staleness_s,
      eventsAfterCheckpoint: p.events_after,
    })),
    gateways: gateways.rows.map((g) => ({
      gatewayId: g.gateway_id,
      segmentId: g.segment_id,
      lastSeenAt: g.last_seen_at,
      reportedWatermark: g.reported_watermark,
      effectiveWatermark: g.effective_watermark,
      bufferedCount: g.buffered_count,
      lastSeq: g.last_seq,
      batches: g.batches,
      eventsAccepted: g.events_accepted,
      duplicates: g.duplicates,
      coverage: g.coverage,
      silentSeconds: g.silent_s,
      watermarkLagSeconds: g.watermark_lag_s,
    })),
    rates: {
      edgePerSecond: Math.round((rates.rows[0].edge_1m / 60) * 10) / 10,
      domainPerSecond: Math.round((rates.rows[0].domain_1m / 60) * 10) / 10,
      lateLastMinute: rates.rows[0].late_1m,
      edgeTotal: rates.rows[0].edge_total,
      domainTotal: rates.rows[0].domain_total,
    },
    processed: processed.rows,
    dlq: { dead: dlq.filter((d) => d.status === 'dead').length, total: dlq.length },
    serverTime: new Date().toISOString(),
  }
}
