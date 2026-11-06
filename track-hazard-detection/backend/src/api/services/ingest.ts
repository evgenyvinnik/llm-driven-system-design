/**
 * Edge ingest. A gateway (or the PTC train-position feed) posts a batch of
 * events it has buffered, each with its own sequence number. In one
 * transaction the API:
 *
 *  1. stores each new event in the edge inbox, deduplicated on (source, seq)
 *     and on event id, so a resent batch or a duplicated event is a no-op;
 *  2. writes an outbox row per new event, on the lane the server-side policy
 *     picks (critical / bulk / trains), keyed by track segment (or train);
 *  3. records the gateway's heartbeat and its reported watermark.
 *
 * Payloads are stored as delivered (accept-and-store): a malformed payload is
 * dead-lettered by the consumer instead of being rejected here, so one bad
 * event never wedges a gateway's queue. Responding 200 means "durably stored";
 * the gateway may then drop those events from its buffer.
 * @module api/services/ingest
 */
import { z } from 'zod'
import { config } from '../../shared/config.js'
import { withTransaction } from '../../shared/db.js'
import type { Topic } from '../../shared/event-store.js'
import { classifyLane, trainPositionV1 } from '../../shared/events/edge.js'
import type { Envelope, Lane } from '../../shared/events/envelope.js'
import { HttpError } from '../../shared/errors.js'
import { edgeEventsIngested, ingestLagSeconds } from '../../shared/metrics.js'
import { GATEWAY_SEGMENT, segmentAt } from '../../shared/track.js'

export const PTC_SOURCE = 'PTC'

export const edgeEventSchema = z.object({
  eventId: z.string().uuid(),
  seq: z.number().int().nonnegative(),
  type: z.string().min(1).max(64),
  version: z.number().int().positive(),
  occurredAt: z.string().datetime({ offset: true }),
  payload: z.record(z.unknown()),
})

export const batchSchema = z.object({
  sourceId: z.string().min(1).max(64),
  batchId: z.string().min(1).max(64),
  /** "Everything that occurred before this has been delivered" (oldest still-buffered event time). */
  watermark: z.string().datetime({ offset: true }).nullable().optional(),
  bufferedCount: z.number().int().nonnegative().optional(),
  events: z.array(edgeEventSchema).max(config.ingest.maxBatch),
})

export type Batch = z.infer<typeof batchSchema>

export interface IngestResult {
  accepted: number
  duplicates: number
  critical: number
  late: number
}

interface Prepared {
  e: Batch['events'][number]
  sensorId: string | null
  subdivisionId: string | null
  segmentId: string | null
  partitionKey: string
  lane: Lane
  topic: Topic
  late: boolean
  lagMs: number
}

export async function ingestBatch(batch: Batch): Promise<IngestResult> {
  const gatewaySegment = GATEWAY_SEGMENT.get(batch.sourceId)
  if (!gatewaySegment && batch.sourceId !== PTC_SOURCE) throw new HttpError(403, 'UNKNOWN_SOURCE', `Unknown gateway ${batch.sourceId}`)
  const now = new Date()

  return withTransaction(async (client) => {
    const sensorIds = [...new Set(batch.events.map((e) => (typeof e.payload.sensorId === 'string' ? e.payload.sensorId : null)).filter((s): s is string => s !== null))]
    const sensors = new Map<string, { segment_id: string; subdivision_id: string }>()
    if (sensorIds.length) {
      const { rows } = await client.query<{ id: string; segment_id: string; subdivision_id: string }>('SELECT id, segment_id, subdivision_id FROM sensors WHERE id = ANY($1::text[])', [sensorIds])
      for (const r of rows) sensors.set(r.id, r)
    }

    const prepared: Prepared[] = batch.events.map((e) => {
      const lagMs = Math.max(0, now.getTime() - Date.parse(e.occurredAt))
      const late = lagMs > config.ingest.lateAfterMs
      if (e.type === 'TrainPositionReported') {
        const sub = typeof e.payload.subdivisionId === 'string' ? e.payload.subdivisionId : null
        const mp = typeof e.payload.milepost === 'number' ? e.payload.milepost : null
        const seg = sub && mp !== null ? segmentAt(sub, mp) : undefined
        return { e, sensorId: null, subdivisionId: sub, segmentId: seg?.id ?? null, partitionKey: String(e.payload.trainId ?? batch.sourceId), lane: 'trains', topic: 'trains', late, lagMs }
      }
      const sensorId = typeof e.payload.sensorId === 'string' ? e.payload.sensorId : null
      const known = sensorId ? sensors.get(sensorId) : undefined
      // An unregistered sensor is keyed by its gateway's segment; the correlator decides what to do with it.
      const segmentId = known?.segment_id ?? gatewaySegment?.id ?? null
      const lane = classifyLane(e.type, e.payload, config.correlation.vibrationSpikeMmS)
      return {
        e,
        sensorId,
        subdivisionId: known?.subdivision_id ?? gatewaySegment?.subdivisionId ?? null,
        segmentId,
        partitionKey: segmentId ?? batch.sourceId,
        lane,
        topic: lane === 'critical' ? 'edge.critical' : 'edge.bulk',
        late,
        lagMs,
      }
    })

    const inserted = new Set<string>()
    for (let i = 0; i < prepared.length; i += 500) {
      const chunk = prepared.slice(i, i + 500)
      const values: unknown[] = []
      const tuples = chunk.map((p, j) => {
        values.push(p.e.eventId, batch.sourceId, p.e.seq, p.e.type, p.e.version, p.sensorId, p.subdivisionId, p.segmentId, p.partitionKey, p.lane, p.late, p.e.occurredAt, now, p.lagMs, batch.batchId, p.e.payload)
        const b = j * 16
        return `(${Array.from({ length: 16 }, (_, k) => `$${b + k + 1}`).join(', ')})`
      })
      const { rows } = await client.query<{ event_id: string }>(
        `INSERT INTO edge_events (event_id, source_id, seq, type, version, sensor_id, subdivision_id, segment_id, partition_key, lane, late, occurred_at, recorded_at, lag_ms, batch_id, payload)
         VALUES ${tuples.join(', ')} ON CONFLICT DO NOTHING RETURNING event_id`,
        values,
      )
      for (const r of rows) inserted.add(r.event_id)
    }

    const fresh = prepared.filter((p) => inserted.has(p.e.eventId))
    const recordedAt = now.toISOString()
    for (let i = 0; i < fresh.length; i += 500) {
      const chunk = fresh.slice(i, i + 500)
      const values: unknown[] = []
      const tuples = chunk.map((p, j) => {
        const env: Envelope = {
          eventId: p.e.eventId,
          type: p.e.type,
          version: p.e.version,
          occurredAt: new Date(p.e.occurredAt).toISOString(),
          recordedAt,
          streamId: `gw-${batch.sourceId}`,
          streamVersion: p.e.seq,
          partitionKey: p.partitionKey,
          correlationId: p.e.eventId,
          causationId: null,
          source: batch.sourceId,
          meta: { lane: p.lane, late: p.late, sensorId: p.sensorId, segmentId: p.segmentId, subdivisionId: p.subdivisionId, batchId: batch.batchId },
          payload: p.e.payload,
        }
        values.push(p.e.eventId, p.topic, p.lane, p.partitionKey, env)
        return `($${j * 5 + 1}, $${j * 5 + 2}, $${j * 5 + 3}, $${j * 5 + 4}, $${j * 5 + 5})`
      })
      await client.query(`INSERT INTO outbox (event_id, topic, lane, partition_key, envelope) VALUES ${tuples.join(', ')}`, values)
    }

    // Train positions are also reference data ("was a train here at time t?") for the correlator.
    for (const p of fresh.filter((x) => x.e.type === 'TrainPositionReported')) {
      const parsed = trainPositionV1.safeParse(p.e.payload)
      if (!parsed.success) continue
      const t = parsed.data
      await client.query(
        `INSERT INTO train_positions (event_id, train_id, symbol, subdivision_id, milepost, direction, speed_mph, occurred_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT DO NOTHING`,
        [p.e.eventId, t.trainId, t.symbol, t.subdivisionId, t.milepost, t.direction, t.speedMph, p.e.occurredAt],
      )
    }

    if (gatewaySegment) {
      const maxSeq = batch.events.reduce((m, e) => Math.max(m, e.seq), 0)
      await client.query(
        `INSERT INTO gateway_state (gateway_id, segment_id, last_seen_at, reported_watermark, buffered_count, last_seq, batches, events_accepted, duplicates)
         VALUES ($1, $2, $3, $4, $5, $6, 1, $7, $8)
         ON CONFLICT (gateway_id) DO UPDATE SET last_seen_at = EXCLUDED.last_seen_at,
           reported_watermark = GREATEST(gateway_state.reported_watermark, EXCLUDED.reported_watermark),
           buffered_count = EXCLUDED.buffered_count, last_seq = GREATEST(gateway_state.last_seq, EXCLUDED.last_seq),
           batches = gateway_state.batches + 1, events_accepted = gateway_state.events_accepted + EXCLUDED.events_accepted,
           duplicates = gateway_state.duplicates + EXCLUDED.duplicates`,
        [batch.sourceId, gatewaySegment.id, now, batch.watermark ?? now.toISOString(), batch.bufferedCount ?? 0, maxSeq, fresh.length, prepared.length - fresh.length],
      )
    }
    if (fresh.length) {
      const lanes = [...new Set(fresh.map((p) => p.lane))]
      for (const lane of lanes) await client.query(`SELECT pg_notify('outbox', $1)`, [lane])
    }

    for (const p of prepared) {
      const outcome = inserted.has(p.e.eventId) ? 'accepted' : 'duplicate'
      edgeEventsIngested.inc({ type: p.e.type, lane: p.lane, outcome })
      if (outcome === 'accepted') ingestLagSeconds.observe({ lane: p.lane }, p.lagMs / 1000)
    }
    return {
      accepted: fresh.length,
      duplicates: prepared.length - fresh.length,
      critical: fresh.filter((p) => p.lane === 'critical').length,
      late: fresh.filter((p) => p.late).length,
    }
  })
}
