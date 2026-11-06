/**
 * The four projections, by consumer group. Each apply function is used twice:
 * live, by the projector consumer (inside the runtime's transaction), and by
 * `npm run replay`, against shadow tables, from position 0.
 * @module workers/projections
 */
import type { Queryable } from '../../shared/db.js'
import type { LiveEvent } from '../../shared/events.js'
import type { EventEnvelope } from '../../events/envelope.js'
import { applyAlertQueue } from './alert-queue.js'
import { applyCarHistory } from './car-history.js'
import { applyDetectorHealth } from './detector-health.js'
import { applyReliability } from './reliability.js'

export type ApplyFn = (db: Queryable, e: EventEnvelope) => Promise<LiveEvent[]>

export const PROJECTORS: Record<string, ApplyFn> = {
  'proj-alert-queue': applyAlertQueue,
  'proj-car-history': applyCarHistory,
  'proj-detector-health': applyDetectorHealth,
  'proj-reliability': applyReliability,
}
