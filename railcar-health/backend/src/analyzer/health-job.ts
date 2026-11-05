/**
 * Periodic detector status: offline (no heartbeat), silent (trains seen on
 * both sides but not here), biased (reads off vs neighbours), else ok.
 * @module analyzer/health-job
 */
import { config } from '../shared/config.js'
import { pool } from '../shared/db.js'
import { nowMs } from '../shared/clock.js'
import { publishEvents } from '../shared/events.js'
import { logger } from '../shared/logger.js'
import { loadThresholds } from '../shared/thresholds.js'
import { detectorStatus } from './detector-health.js'

export async function runHealthCheck(): Promise<number> {
  const { config: t } = await loadThresholds()
  const now = nowMs()
  const { rows } = await pool.query<{
    id: string; status: string; last_heard_at: Date | null; missed_passes: number; bias_offset_f: number | null; bias_samples: number
  }>('SELECT id, status, last_heard_at, missed_passes, bias_offset_f, bias_samples FROM detectors')
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
    const res = await pool.query(
      `UPDATE detectors SET status = $2, status_reason = $3,
              status_since = CASE WHEN status = $2 THEN status_since ELSE $4 END
        WHERE id = $1 AND (status <> $2 OR status_reason IS DISTINCT FROM $3)`,
      [d.id, next.status, next.reason, new Date(now)],
    )
    if (res.rowCount && d.status !== next.status) {
      changed += 1
      logger.info({ detector: d.id, from: d.status, to: next.status, reason: next.reason }, 'detector status changed')
    }
  }
  if (changed > 0) await publishEvents([{ type: 'detector.updated' }])
  return changed
}

export function startHealthJob(): () => void {
  const timer = setInterval(() => {
    runHealthCheck().catch((err) => logger.warn({ err: (err as Error).message }, 'health check failed'))
  }, config.analysis.healthIntervalMs)
  return () => clearInterval(timer)
}
