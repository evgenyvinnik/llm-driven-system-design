/**
 * Periodic detector status: offline (no heartbeat), silent (trains seen on
 * both sides but not here), biased (reads off vs neighbours), else ok.
 *
 * Each detector's status is a small event stream (detector-<id>): a change is
 * appended as DetectorHealthChanged with the detector stream's version as the
 * expected version, so two analyzers running the job can't both record the same
 * transition. The detector-health projection builds the screen's table.
 * @module analyzer/health-job
 */
import { config } from '../shared/config.js'
import { pool } from '../shared/db.js'
import { nowMs } from '../shared/clock.js'
import { logger } from '../shared/logger.js'
import { loadThresholds } from '../shared/thresholds.js'
import { streamIds } from '../events/catalog.js'
import { ConcurrencyError, withEventTransaction } from '../events/store.js'
import { detectorStatus } from './detector-health.js'

export async function runHealthCheck(): Promise<number> {
  const { config: t } = await loadThresholds()
  const now = nowMs()
  const { rows } = await pool.query<{
    id: string; last_heard_at: Date | null; missed_passes: number; bias_offset_f: number | null; bias_samples: number; status: string | null; version: number | null
  }>(
    `SELECT d.id, d.last_heard_at, d.missed_passes, d.bias_offset_f, d.bias_samples, e.payload->>'to' AS status, e.stream_version AS version
       FROM detectors d
       LEFT JOIN LATERAL (SELECT payload, stream_version FROM events WHERE stream_id = 'detector-' || d.id ORDER BY stream_version DESC LIMIT 1) e ON true`,
  )
  let changed = 0
  for (const d of rows) {
    const biased = d.bias_offset_f !== null && d.bias_samples >= t.biasMinSamples && Math.abs(d.bias_offset_f) >= t.biasAlarmF
    const next = detectorStatus({
      lastHeardAtMs: d.last_heard_at ? d.last_heard_at.getTime() : null,
      nowMs: now,
      offlineAfterMs: config.analysis.offlineAfterMinutes * 60_000,
      missedRecent: d.missed_passes,
      biased,
      biasOffset: d.bias_offset_f,
    })
    const from = (d.status ?? 'ok') as 'ok' | 'offline' | 'silent' | 'biased'
    if (from === next.status) continue
    try {
      await withEventTransaction({ correlationId: `detector-health:${d.id}`, actor: 'analyzer:health-job' }, async ({ batch }) => {
        batch.append(streamIds.detector(d.id), d.version ?? 'no_stream', {
          type: 'DetectorHealthChanged', occurredAt: new Date(now), tags: [`detector:${d.id}`],
          payload: { detectorId: d.id, from, to: next.status, reason: next.reason, biasOffsetF: d.bias_offset_f, missedPasses: d.missed_passes, lastHeardAt: d.last_heard_at?.toISOString() ?? null },
        })
      }, 0)
      changed += 1
      logger.info({ detector: d.id, from, to: next.status, reason: next.reason }, 'detector status changed')
    } catch (err) {
      if (!(err instanceof ConcurrencyError)) throw err // another analyzer recorded it first
    }
  }
  return changed
}

export function startHealthJob(): () => void {
  const timer = setInterval(() => {
    runHealthCheck().catch((err) => logger.warn({ err: (err as Error).message }, 'health check failed'))
  }, config.analysis.healthIntervalMs)
  return () => clearInterval(timer)
}
