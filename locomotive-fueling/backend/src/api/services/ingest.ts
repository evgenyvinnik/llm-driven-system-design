/**
 * Telemetry ingest. The edge does as little as possible: validate, drop exact
 * duplicates within the batch, order each locomotive's readings by sequence,
 * and append them to the partition stream for that locomotive. Success means
 * "durably in the log"; smoothing and alerts happen downstream.
 *
 * Dedup happens twice, on purpose:
 * - batch id (fast path): a device that retries after losing our response
 *   gets "duplicate" without re-appending anything;
 * - (locomotive, seq) in the processor (the real guarantee): readings
 *   re-appended for any reason collide on the history table's primary key.
 * The batch marker is written only after the append succeeds, so a failed
 * append is retried in full rather than wrongly reported as a duplicate.
 * @module api/services/ingest
 */
import { z } from 'zod'
import { keys, redis } from '../../shared/cache.js'
import { config } from '../../shared/config.js'
import { telemetryIngested } from '../../shared/metrics.js'
import { partitionFor } from '../../shared/partition.js'

const timestamp = z.union([z.string().datetime(), z.number()]).transform((v) => (typeof v === 'number' ? v : Date.parse(v)))

export const readingSchema = z.object({
  locomotiveId: z.string().min(1).max(32),
  seq: z.number().int().nonnegative(),
  recordedAt: timestamp,
  lat: z.number().min(-90).max(90),
  lon: z.number().min(-180).max(180),
  milepost: z.number().min(0),
  speedMph: z.number().min(0).max(120),
  notch: z.number().int().min(0).max(8),
  fuelGal: z.number().min(-100).max(10000),
  engineState: z.enum(['run', 'idle', 'off']),
})

export const batchSchema = z.object({
  batchId: z.string().min(8).max(100),
  sentAt: timestamp.optional(),
  readings: z.array(readingSchema).min(1).max(config.telemetry.maxBatch),
})

export type IngestReading = z.infer<typeof readingSchema>

/** Drops exact (locomotive, seq) repeats and orders each locomotive's readings by seq. */
export function normalizeBatch(readings: IngestReading[]): IngestReading[] {
  const seen = new Set<string>()
  const unique = readings.filter((r) => {
    const k = `${r.locomotiveId}:${r.seq}`
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
  return unique.sort((a, b) => (a.locomotiveId === b.locomotiveId ? a.seq - b.seq : a.locomotiveId < b.locomotiveId ? -1 : 1))
}

export async function ingestBatch(body: unknown): Promise<{ accepted: number; duplicate: boolean }> {
  const batch = batchSchema.parse(body)
  if (await redis.exists(keys.batchSeen(batch.batchId))) {
    telemetryIngested.inc({ outcome: 'duplicate_batch' }, batch.readings.length)
    return { accepted: 0, duplicate: true }
  }
  const readings = normalizeBatch(batch.readings)
  const pipe = redis.pipeline()
  for (const r of readings) {
    const stream = keys.telemetryStream(partitionFor(r.locomotiveId, config.telemetry.partitions))
    pipe.xadd(stream, 'MAXLEN', '~', String(config.telemetry.streamMaxLen), '*', 'r', JSON.stringify(r))
  }
  const results = (await pipe.exec()) ?? []
  const failed = results.find(([err]) => err)
  if (failed) throw failed[0]
  await redis.set(keys.batchSeen(batch.batchId), '1', 'EX', config.telemetry.batchDedupTtlSeconds)
  telemetryIngested.inc({ outcome: 'accepted' }, readings.length)
  return { accepted: readings.length, duplicate: false }
}
