/**
 * Ingest from detector-site gateways. Gateways store and forward over flaky
 * cellular or satellite links, so delivery is at-least-once, out of order and
 * sometimes hours late. The detector-assigned (detectorId, passId) is the
 * idempotency key: a retried pass is acknowledged as a duplicate and changes
 * nothing.
 *
 * Raw readings are an append-only fact log (detector_passes + axle_readings),
 * not an event-sourced aggregate: there is a lot of data and no invariant
 * between one reading and the next. In the SAME transaction as the fact rows,
 * ingest appends PassRecorded and AxleReadingsRecorded to the event store, which
 * is the transactional outbox: no stored pass without its events, no event
 * without its pass. The relay publishes them; nothing here talks to the broker.
 * A pass is acknowledged (2xx) only after that transaction commits.
 *
 * AxleReadingsRecorded is a claim check: it names the fact-log rows instead of
 * carrying ~700 readings. Its lane (live or backfill) is chosen here by how late
 * the pass is, so a reconnecting site's backlog never queues ahead of fresh data.
 * @module api/services/ingest
 */
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { config } from '../../shared/config.js'
import { pool, type Queryable } from '../../shared/db.js'
import { HttpError } from '../../shared/errors.js'
import { logger } from '../../shared/logger.js'
import { ingestLagMinutes, passesIngested } from '../../shared/metrics.js'
import { laneFor, type Lane } from '../../shared/stream.js'
import { streamIds } from '../../events/catalog.js'
import { withEventTransaction, type EventBatch } from '../../events/store.js'

const isoDate = z.string().datetime({ offset: true })

export const passSchema = z
  .object({
    passId: z.string().min(1).max(64),
    detectorId: z.string().min(1).max(32),
    tripId: z.string().min(1).max(64),
    passedAt: isoDate,
    direction: z.enum(['EB', 'WB']),
    speedMph: z.number().min(0).max(90),
    ambientF: z.number().min(-60).max(130),
    axleCount: z.number().int().min(1).max(2000),
    axles: z
      .array(z.object({ seq: z.number().int().min(1), rail: z.enum(['N', 'S']), bearingF: z.number().min(-80).max(700), wheelF: z.number().min(-80).max(1400) }))
      .min(1)
      .max(4000),
    aei: z.array(z.object({ position: z.number().int().min(1), unitId: z.string().min(1).max(32), leadingEnd: z.enum(['A', 'B']) })).max(500).optional(),
    edgeAlarms: z.array(z.object({ axleSeq: z.number().int().min(1), rail: z.enum(['N', 'S']), kind: z.enum(['hot_bearing', 'hot_wheel']) })).max(50).optional(),
  })
  .refine((p) => p.axles.every((a) => a.seq <= p.axleCount), { message: 'axle seq exceeds axleCount', path: ['axles'] })

export const batchSchema = z.object({
  gatewayId: z.string().min(1).max(32),
  sentAt: isoDate,
  passes: z.array(passSchema).min(1).max(50),
})

export type PassInput = z.infer<typeof passSchema>
export type BatchInput = z.infer<typeof batchSchema>

export interface PassResult {
  detectorId: string
  passId: string
  status: 'accepted' | 'duplicate' | 'conflict'
  lagMinutes: number
  late: boolean
  lane: Lane
}

export function payloadSha(pass: PassInput): string {
  return createHash('sha256').update(JSON.stringify([pass.tripId, pass.passedAt, pass.axleCount, pass.axles])).digest('hex')
}

export function lagMinutesOf(passedAt: string, receivedAt: Date): number {
  return Math.max(0, (receivedAt.getTime() - new Date(passedAt).getTime()) / 60_000)
}

async function insertReadings(client: Queryable, pass: PassInput): Promise<void> {
  await client.query(
    `INSERT INTO axle_readings (detector_id, pass_id, axle_seq, rail, bearing_f, wheel_f)
     SELECT $1, $2, a.seq, a.rail, a.bearing, a.wheel FROM unnest($3::int[], $4::text[], $5::numeric[], $6::numeric[]) AS a(seq, rail, bearing, wheel)
     ON CONFLICT DO NOTHING`,
    [pass.detectorId, pass.passId, pass.axles.map((a) => a.seq), pass.axles.map((a) => a.rail), pass.axles.map((a) => a.bearingF), pass.axles.map((a) => a.wheelF)],
  )
}

/** Stages the two outbox events for a newly stored pass. */
export function stagePassEvents(batch: EventBatch, pass: PassInput, gatewayId: string, receivedAt: Date, lagSeconds: number, sha: string): void {
  const lane = laneFor(lagSeconds)
  const streamId = streamIds.pass(pass.detectorId, pass.passId)
  const correlationId = `pass:${pass.detectorId}/${pass.passId}`
  const tags = [`trip:${pass.tripId}`, `detector:${pass.detectorId}`]
  const recorded = batch.append(streamId, 'no_stream', {
    type: 'PassRecorded',
    occurredAt: pass.passedAt,
    recordedAt: receivedAt,
    correlationId,
    causationId: null,
    tags,
    payload: {
      detectorId: pass.detectorId, passId: pass.passId, tripId: pass.tripId, gatewayId, direction: pass.direction, passedAt: pass.passedAt,
      receivedAt: receivedAt.toISOString(), lagSeconds: Math.round(lagSeconds), lane, speedMph: pass.speedMph, ambientF: pass.ambientF,
      axleCount: pass.axleCount, aeiRead: Boolean(pass.aei?.length), edgeAlarmCount: pass.edgeAlarms?.length ?? 0,
    },
  })
  batch.append(streamId, 'no_stream', {
    type: 'AxleReadingsRecorded',
    occurredAt: pass.passedAt,
    recordedAt: receivedAt,
    correlationId,
    causationId: recorded,
    tags,
    payload: {
      detectorId: pass.detectorId, passId: pass.passId, tripId: pass.tripId, lane, axleCount: pass.axleCount, readingCount: pass.axles.length,
      payloadSha: sha, claimCheck: { store: 'axle_readings', detectorId: pass.detectorId, passId: pass.passId },
      maxBearingF: Math.max(...pass.axles.map((a) => a.bearingF)), maxWheelF: Math.max(...pass.axles.map((a) => a.wheelF)),
    },
  })
}

export async function ingestBatch(batch: BatchInput, receivedAt: Date): Promise<{ accepted: number; duplicates: number; conflicts: number; results: PassResult[] }> {
  const detectorIds = [...new Set(batch.passes.map((p) => p.detectorId))]
  const known = await pool.query<{ id: string }>('SELECT id FROM detectors WHERE id = ANY($1)', [detectorIds])
  const unknown = detectorIds.filter((id) => !known.rows.some((r) => r.id === id))
  if (unknown.length > 0) throw new HttpError(422, 'UNKNOWN_DETECTOR', `Unknown detector(s): ${unknown.join(', ')}`)

  const { result: results } = await withEventTransaction({ correlationId: `gateway:${batch.gatewayId}`, actor: `gateway:${batch.gatewayId}` }, async ({ client, batch: events }) => {
    const out: PassResult[] = []
    for (const pass of batch.passes) {
      const lagMinutes = lagMinutesOf(pass.passedAt, receivedAt)
      const late = lagMinutes > config.analysis.lateAfterMinutes
      const lane = laneFor(lagMinutes * 60)
      const sha = payloadSha(pass)
      const inserted = await client.query(
        `INSERT INTO detector_passes (detector_id, pass_id, trip_id, gateway_id, direction, passed_at, sent_at, received_at, speed_mph,
                                      ambient_f, axle_count, aei, edge_alarms, payload_sha)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
         ON CONFLICT (detector_id, pass_id) DO NOTHING`,
        [pass.detectorId, pass.passId, pass.tripId, batch.gatewayId, pass.direction, pass.passedAt, batch.sentAt, receivedAt, pass.speedMph,
          pass.ambientF, pass.axleCount, pass.aei ? JSON.stringify(pass.aei) : null, pass.edgeAlarms ? JSON.stringify(pass.edgeAlarms) : null, sha],
      )
      if (inserted.rowCount === 1) {
        await insertReadings(client, pass)
        stagePassEvents(events, pass, batch.gatewayId, receivedAt, lagMinutes * 60, sha)
        out.push({ detectorId: pass.detectorId, passId: pass.passId, status: 'accepted', lagMinutes: Math.round(lagMinutes), late, lane })
        ingestLagMinutes.observe(lagMinutes)
        continue
      }
      // A retry: the pass and its events were committed together the first time, so there is nothing to publish.
      const prior = await client.query<{ payload_sha: string }>('SELECT payload_sha FROM detector_passes WHERE detector_id = $1 AND pass_id = $2', [pass.detectorId, pass.passId])
      const conflict = prior.rows[0]?.payload_sha !== sha
      if (conflict) logger.warn({ detectorId: pass.detectorId, passId: pass.passId }, 'pass retried with different readings; keeping the first copy')
      out.push({ detectorId: pass.detectorId, passId: pass.passId, status: conflict ? 'conflict' : 'duplicate', lagMinutes: Math.round(lagMinutes), late, lane })
    }
    return out
  })

  const accepted = results.filter((r) => r.status === 'accepted').length
  const duplicates = results.filter((r) => r.status === 'duplicate').length
  const conflicts = results.filter((r) => r.status === 'conflict').length
  passesIngested.inc({ outcome: 'accepted' }, accepted)
  passesIngested.inc({ outcome: 'duplicate' }, duplicates + conflicts)
  return { accepted, duplicates, conflicts, results }
}
