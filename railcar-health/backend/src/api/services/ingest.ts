/**
 * Ingest from detector-site gateways. Gateways store and forward over flaky
 * cellular or satellite links, so delivery is at-least-once, out of order and
 * sometimes hours late. The detector-assigned (detectorId, passId) is the
 * idempotency key: a retried pass is acknowledged as a duplicate and changes
 * nothing. A pass is acknowledged only after its readings are committed.
 *
 * Publishing to the stream happens after commit. If the process dies in
 * between, the gateway never got a 2xx and retries: the retry finds the pass
 * stored but unpublished and publishes it. The republisher sweep covers a
 * gateway that gave up.
 *
 * Each pass goes to the live or backfill lane by how late it is, so a
 * reconnecting site's backlog never queues ahead of fresh readings.
 * @module api/services/ingest
 */
import { createHash } from 'node:crypto'
import type { Redis } from 'ioredis'
import { z } from 'zod'
import { config } from '../../shared/config.js'
import { pool, withTransaction } from '../../shared/db.js'
import { HttpError } from '../../shared/errors.js'
import { logger } from '../../shared/logger.js'
import { ingestLagMinutes, passesIngested } from '../../shared/metrics.js'
import { laneFor, publishPass, type Lane } from '../../shared/stream.js'

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

export interface Publishable {
  detectorId: string
  passId: string
  lagSeconds: number
}

export function payloadSha(pass: PassInput): string {
  return createHash('sha256').update(JSON.stringify([pass.tripId, pass.passedAt, pass.axleCount, pass.axles])).digest('hex')
}

export function lagMinutesOf(passedAt: string, receivedAt: Date): number {
  return Math.max(0, (receivedAt.getTime() - new Date(passedAt).getTime()) / 60_000)
}

async function insertReadings(client: { query: typeof pool.query }, pass: PassInput): Promise<void> {
  await client.query(
    `INSERT INTO axle_readings (detector_id, pass_id, axle_seq, rail, bearing_f, wheel_f)
     SELECT $1, $2, a.seq, a.rail, a.bearing, a.wheel FROM unnest($3::int[], $4::text[], $5::numeric[], $6::numeric[]) AS a(seq, rail, bearing, wheel)
     ON CONFLICT DO NOTHING`,
    [pass.detectorId, pass.passId, pass.axles.map((a) => a.seq), pass.axles.map((a) => a.rail), pass.axles.map((a) => a.bearingF), pass.axles.map((a) => a.wheelF)],
  )
}

export async function ingestBatch(batch: BatchInput, receivedAt: Date, streamClient: Redis): Promise<{ accepted: number; duplicates: number; conflicts: number; results: PassResult[] }> {
  const detectorIds = [...new Set(batch.passes.map((p) => p.detectorId))]
  const known = await pool.query<{ id: string }>('SELECT id FROM detectors WHERE id = ANY($1)', [detectorIds])
  const unknown = detectorIds.filter((id) => !known.rows.some((r) => r.id === id))
  if (unknown.length > 0) throw new HttpError(422, 'UNKNOWN_DETECTOR', `Unknown detector(s): ${unknown.join(', ')}`)

  const results: PassResult[] = []
  const toPublish: Publishable[] = []
  await withTransaction(async (client) => {
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
        toPublish.push({ detectorId: pass.detectorId, passId: pass.passId, lagSeconds: lagMinutes * 60 })
        results.push({ detectorId: pass.detectorId, passId: pass.passId, status: 'accepted', lagMinutes: Math.round(lagMinutes), late, lane })
        ingestLagMinutes.observe(lagMinutes)
        continue
      }
      const prior = await client.query<{ payload_sha: string; published_at: Date | null }>(
        'SELECT payload_sha, published_at FROM detector_passes WHERE detector_id = $1 AND pass_id = $2',
        [pass.detectorId, pass.passId],
      )
      const row = prior.rows[0]
      const conflict = row.payload_sha !== sha
      if (conflict) logger.warn({ detectorId: pass.detectorId, passId: pass.passId }, 'pass retried with different readings; keeping the first copy')
      // A retry after a crash between commit and publish: publish now.
      if (row.published_at === null) toPublish.push({ detectorId: pass.detectorId, passId: pass.passId, lagSeconds: lagMinutes * 60 })
      results.push({ detectorId: pass.detectorId, passId: pass.passId, status: conflict ? 'conflict' : 'duplicate', lagMinutes: Math.round(lagMinutes), late, lane })
    }
  })

  await publishAll(streamClient, toPublish)
  const accepted = results.filter((r) => r.status === 'accepted').length
  const duplicates = results.filter((r) => r.status === 'duplicate').length
  const conflicts = results.filter((r) => r.status === 'conflict').length
  passesIngested.inc({ outcome: 'accepted' }, accepted)
  passesIngested.inc({ outcome: 'duplicate' }, duplicates + conflicts)
  return { accepted, duplicates, conflicts, results }
}

export async function publishAll(streamClient: Redis, passes: Publishable[]): Promise<void> {
  for (const p of passes) {
    await publishPass(streamClient, laneFor(p.lagSeconds), p.detectorId, p.passId)
    await pool.query('UPDATE detector_passes SET published_at = now() WHERE detector_id = $1 AND pass_id = $2', [p.detectorId, p.passId])
  }
}

/** Publishes committed passes that never reached the stream (the process died before publishing). */
export async function republishStale(streamClient: Redis): Promise<number> {
  const { rows } = await pool.query<{ detector_id: string; pass_id: string; lag_seconds: number }>(
    `SELECT detector_id, pass_id, lag_seconds FROM detector_passes
      WHERE published_at IS NULL AND inserted_at < now() - ($1 || ' milliseconds')::interval
      ORDER BY inserted_at LIMIT 200`,
    [String(config.stream.republishAfterMs)],
  )
  await publishAll(streamClient, rows.map((r) => ({ detectorId: r.detector_id, passId: r.pass_id, lagSeconds: r.lag_seconds })))
  return rows.length
}
