/**
 * The analyzer's consumer-group handlers. It reads, in priority order:
 *   wayside.readings.live      AxleReadingsRecorded: fresh passes, always drained first
 *   wayside.readings.backfill  AxleReadingsRecorded: buffered passes, two at a time between live checks
 *   identity                   ConsistVersionChanged: releases passes quarantined for want of a consist
 *   cars                       ComponentReplaced: re-decides the car's open trips now
 *
 * Each message runs in the runtime's transaction (processed-events dedupe,
 * checkpoint, staged events), so a redelivered message changes nothing.
 * @module analyzer/consumer
 */
import type { Redis } from 'ioredis'
import { config } from '../shared/config.js'
import type { LiveEvent } from '../shared/events.js'
import { logger } from '../shared/logger.js'
import { alertTransitions, passesProcessed, processSeconds } from '../shared/metrics.js'
import { runConsumerGroup, type Handler } from '../events/consumer.js'
import { groupSpec } from '../events/topology.js'
import { processPass, rescoreTrip, type ProcessResult } from './pipeline.js'
import { tierName } from './risk.js'

function record(result: ProcessResult, lane: string, extra: Record<string, unknown>): void {
  passesProcessed.inc({ outcome: result.outcome, lane })
  for (const t of result.transitions) alertTransitions.inc({ transition: t.transition, tier: tierName(t.tier), late: String(t.late) })
  if (result.outcome !== 'processed' || result.transitions.length > 0 || result.corrections > 0 || result.excludedPreInstall > 0) {
    logger.info({ lane, ...extra, outcome: result.outcome, transitions: result.transitions, corrections: result.corrections, excludedPreInstall: result.excludedPreInstall }, 'pass handled')
  }
}

export const analyzerHandler: Handler = async (event, tx) => {
  const p = event.payload as Record<string, unknown>
  if (event.type === 'AxleReadingsRecorded') {
    const lane = String(p.lane)
    const end = processSeconds.startTimer({ lane })
    // Claim check: the readings are read from the fact log by (detector, pass).
    const result = await processPass(tx, String(p.detectorId), String(p.passId))
    end()
    record(result, lane, { detectorId: p.detectorId, passId: p.passId })
    return { notices: result.notices }
  }
  if (event.type === 'ConsistVersionChanged') {
    // Passes that beat their consist, and passes after a rebuild that couldn't match the old one.
    const { rows } = await tx.client.query<{ detector_id: string; pass_id: string }>(
      `UPDATE detector_passes SET identity_status = 'pending', processed_at = NULL
        WHERE trip_id = $1 AND (identity_status = 'awaiting_consist' OR (identity_status = 'unresolved' AND passed_at >= $2))
        RETURNING detector_id, pass_id, passed_at`,
      [p.tripId, p.effectiveAt],
    )
    const notices: LiveEvent[] = []
    for (const r of rows) {
      const result = await processPass(tx, r.detector_id, r.pass_id)
      record(result, 'released', { detectorId: r.detector_id, passId: r.pass_id, releasedBy: `consist rev ${p.revision}` })
      notices.push(...result.notices)
    }
    return { notices }
  }
  if (event.type === 'ComponentReplaced') {
    const { rows } = await tx.client.query<{ trip_id: string }>(
      `SELECT DISTINCT trip_id FROM case_index WHERE car_id = $1 AND is_open AND case_type = 'alert'
       UNION
       SELECT t.trip_id FROM trips t JOIN current_trip_units u ON u.trip_id = t.trip_id WHERE u.unit_id = $1 AND t.status = 'en_route'`,
      [p.carId],
    )
    const notices: LiveEvent[] = []
    for (const r of rows) notices.push(...(await rescoreTrip(tx, r.trip_id)).notices)
    return { notices }
  }
  return undefined
}

export function runAnalyzer(redis: Redis, shouldStop: () => boolean): Promise<void> {
  return runConsumerGroup({
    spec: groupSpec('analyzer')!,
    handler: analyzerHandler,
    redis,
    shouldStop,
    batchFor: (family) => (family === 'wayside.readings.backfill' ? config.stream.backfillBatch : 50),
  })
}
