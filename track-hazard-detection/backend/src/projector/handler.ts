/**
 * Projector message handling: domain events go through every projection in one
 * transaction; train positions update the train strip-map view.
 * @module projector/handler
 */
import { withTransaction } from '../shared/db.js'
import type { Envelope } from '../shared/events/envelope.js'
import type { HandlerOutcome } from '../shared/consumer.js'
import type { LiveNotice, LiveTopic } from '../shared/live.js'
import { PROJECTIONS } from './projections.js'
import { applyEvent } from './store.js'

const TOPICS_BY_TYPE: Record<string, LiveTopic[]> = {
  SpeedRestrictionIssued: ['restrictions', 'hazards'],
  SpeedRestrictionLifted: ['restrictions', 'hazards'],
  AlertIssued: ['alerts', 'hazards', 'latency'],
  AlertEscalated: ['alerts', 'hazards'],
  AlertAcknowledged: ['alerts', 'hazards'],
  CoverageDegraded: ['coverage'],
  CoverageRestored: ['coverage'],
}

export async function handleDomainEvent(env: Envelope): Promise<{ outcome: HandlerOutcome; notice: LiveNotice | null }> {
  const outcomes = await withTransaction(async (client) => {
    const out: string[] = []
    for (const p of PROJECTIONS) out.push(await applyEvent(client, p, env))
    return out
  })
  if (!outcomes.includes('applied')) return { outcome: outcomes.includes('duplicate') ? 'duplicate' : 'skipped', notice: null }
  const topics = TOPICS_BY_TYPE[env.type] ?? (env.streamId.startsWith('hazard-') ? (['hazards', 'alerts'] as LiveTopic[]) : (['ops'] as LiveTopic[]))
  const p = env.payload as { severity?: string; toSeverity?: string }
  return { outcome: 'ok', notice: { topics, type: env.type, hazardId: env.streamId.startsWith('hazard-') ? env.streamId.slice(7) : undefined, severity: p.severity ?? p.toSeverity } }
}

export async function handleTrainEvent(env: Envelope): Promise<HandlerOutcome> {
  const p = env.payload as { trainId: string; symbol: string; subdivisionId: string; milepost: number; direction: string; speedMph: number }
  const { rowCount } = await withTransaction((client) =>
    client.query(
      `INSERT INTO train_view (train_id, symbol, subdivision_id, milepost, direction, speed_mph, occurred_at) VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (train_id) DO UPDATE SET symbol = EXCLUDED.symbol, subdivision_id = EXCLUDED.subdivision_id, milepost = EXCLUDED.milepost,
         direction = EXCLUDED.direction, speed_mph = EXCLUDED.speed_mph, occurred_at = EXCLUDED.occurred_at
       WHERE train_view.occurred_at < EXCLUDED.occurred_at`,
      [p.trainId, p.symbol, p.subdivisionId, p.milepost, p.direction, p.speedMph, env.occurredAt],
    ),
  )
  return (rowCount ?? 0) > 0 ? 'ok' : 'duplicate'
}
