/**
 * Runs a projection as a consumer group. The apply function writes the read
 * model inside the runtime's transaction (with the processed-events insert and
 * the checkpoint), and the live notices for the browsers go out only after that
 * commit, so a screen that refetches on a notice sees the change.
 * @module workers/projector
 */
import type { Queryable } from '../shared/db.js'
import type { LiveEvent } from '../shared/events.js'
import type { Handler } from '../events/consumer.js'
import { PROJECTORS } from './projections/index.js'

/** Fills in trip, yard and desk on alert notices so the SSE hub can filter them per viewer. */
async function enrich(db: Queryable, notices: LiveEvent[]): Promise<LiveEvent[]> {
  const out: LiveEvent[] = []
  for (const n of notices) {
    if (n.alertId && (n.yardId === undefined || n.tripId === undefined)) {
      const { rows } = await db.query<{ trip_id: string; yard_id: string | null; desk_id: string | null }>(
        `SELECT trip_id, yard_id, desk_id FROM alerts WHERE id = $1
         UNION ALL SELECT trip_id, yard_id, NULL FROM work_orders WHERE case_id = $1 LIMIT 1`,
        [n.alertId],
      )
      const r = rows[0]
      out.push({ ...n, tripId: n.tripId ?? r?.trip_id, yardId: n.yardId ?? r?.yard_id ?? null, deskId: n.deskId ?? r?.desk_id ?? null })
    } else out.push(n)
  }
  return out
}

export function projectionHandler(group: string): Handler {
  const apply = PROJECTORS[group]
  if (!apply) throw new Error(`no projector for ${group}`)
  return async (event, { client }) => ({ notices: await enrich(client, await apply(client, event)) })
}
