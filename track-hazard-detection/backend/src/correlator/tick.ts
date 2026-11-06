/**
 * The correlator's periodic tick (leader only):
 *
 * - Advances each segment's watermark. While its gateway is active the
 *   watermark follows what the gateway reports ("everything before T is
 *   delivered"). While the gateway is silent past the idle timeout, the
 *   watermark advances on processing time instead, so windows still close and
 *   the gateway's backlog, when it reconnects, is correctly marked late. The
 *   watermark never moves backwards.
 * - Marks a silent gateway's segment as degraded coverage (CoverageDegraded on
 *   `gateway-<id>`) and restores it when the gateway is heard again.
 * - Expires candidate evidence whose window closed below the detect threshold
 *   (display only; a late event can still complete the cluster).
 * @module correlator/tick
 */
import { config } from '../shared/config.js'
import { withTransaction } from '../shared/db.js'
import { appendToStream, streamVersion } from '../shared/event-store.js'
import { draft } from '../shared/events/domain.js'
import { logger } from '../shared/logger.js'
import { GATEWAY_SEGMENT } from '../shared/track.js'

interface GatewayRow {
  gateway_id: string
  segment_id: string
  last_seen_at: Date | null
  coverage: 'ok' | 'degraded'
  active: boolean
}

export async function tick(): Promise<void> {
  const idleSeconds = config.correlation.gatewayIdleMs / 1000
  await withTransaction(async (client) => {
    await client.query(
      `UPDATE gateway_state SET effective_watermark = GREATEST(
         effective_watermark,
         CASE WHEN last_seen_at >= now() - make_interval(secs => $1) THEN reported_watermark ELSE now() - make_interval(secs => $1) END)
       WHERE last_seen_at IS NOT NULL`,
      [idleSeconds],
    )
    const { rows } = await client.query<GatewayRow>(
      `SELECT gateway_id, segment_id, last_seen_at, coverage, last_seen_at >= now() - make_interval(secs => $1) AS active FROM gateway_state WHERE last_seen_at IS NOT NULL FOR UPDATE`,
      [idleSeconds],
    )
    for (const g of rows) {
      const seg = GATEWAY_SEGMENT.get(g.gateway_id)
      if (!seg) continue
      const streamId = `gateway-${g.gateway_id}`
      if (!g.active && g.coverage === 'ok') {
        const since = new Date(g.last_seen_at!).toISOString()
        await appendToStream(client, streamId, await streamVersion(client, streamId), [
          draft('CoverageDegraded', { scope: 'gateway', targetId: g.gateway_id, subdivisionId: seg.subdivisionId, segmentId: seg.id, mpFrom: seg.startMp, mpTo: seg.endMp, reason: 'gateway_silent', since }),
        ], { partitionKey: seg.id, source: 'correlator', meta: { actor: 'correlator' } })
        await client.query(`UPDATE gateway_state SET coverage = 'degraded', coverage_since = $2 WHERE gateway_id = $1`, [g.gateway_id, since])
        logger.warn({ gateway: g.gateway_id }, 'gateway silent: segment coverage degraded')
      } else if (g.active && g.coverage === 'degraded') {
        await appendToStream(client, streamId, await streamVersion(client, streamId), [
          draft('CoverageRestored', { scope: 'gateway', targetId: g.gateway_id, subdivisionId: seg.subdivisionId, segmentId: seg.id, restoredAt: new Date(g.last_seen_at!).toISOString() }),
        ], { partitionKey: seg.id, source: 'correlator', meta: { actor: 'correlator' } })
        await client.query(`UPDATE gateway_state SET coverage = 'ok', coverage_since = NULL WHERE gateway_id = $1`, [g.gateway_id])
        logger.info({ gateway: g.gateway_id }, 'gateway back: segment coverage restored')
      }
    }
    await client.query(
      `UPDATE evidence e SET expired = true FROM segments s JOIN gateway_state g ON g.gateway_id = s.gateway_id
       WHERE e.segment_id = s.id AND e.hazard_id IS NULL AND NOT e.expired AND e.explained_by_train IS NULL
         AND e.occurred_at < g.effective_watermark - make_interval(secs => $1)`,
      [config.correlation.windowSeconds],
    )
  })
}
