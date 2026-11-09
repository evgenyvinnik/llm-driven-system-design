/**
 * Says why a move changed, in the words a yardmaster would use, from the triggers
 * the solve absorbed. Everything else is called what it is: a knock-on.
 * @module plans/explain
 */
import type { Queryable } from '../shared/db.js'
import type { MoveChange } from '../domain/diff.js'

interface Trigger {
  kind: string
  detail: Record<string, unknown>
}

export async function triggersFor(db: Queryable, solveId: string | null): Promise<Trigger[]> {
  if (!solveId) return []
  const { rows } = await db.query(`SELECT kind, detail FROM replan_triggers WHERE solve_id = $1 ORDER BY id`, [solveId])
  return rows.map((r) => ({ kind: r.kind, detail: r.detail ?? {} }))
}

export function explainChange(change: MoveChange, triggers: Trigger[]): string {
  const m = change.after ?? change.before
  if (!m) return 'unknown'
  const cars = new Set([...(change.before?.carIds ?? []), ...(change.after?.carIds ?? [])])
  for (const t of triggers) {
    const d = t.detail
    if (t.kind === 'late_train') {
      const inbound = d.inboundId as string
      if (m.inboundId === inbound || [...cars].some((id) => id.startsWith(`${inbound}-`))) {
        return `${d.symbol} slipped ${d.slipMin} min: ${m.kind === 'assemble' ? 'this pull carries its cars' : 'these cars come in on it'}`
      }
    }
    if ((t.kind === 'hold_placed' || t.kind === 'hold_released' || t.kind === 'hold_coupled') && cars.has(d.carId as string)) {
      return `${d.carId} ${t.kind === 'hold_released' ? 'came off hold' : 'went on hold'}`
    }
    if (t.kind === 'track_blocked' || (t.kind === 'crew_exception' && d.type === 'track_blocked')) {
      const track = d.trackId as string
      if (change.before?.toTrackId === track || change.before?.fromTrackId === track || m.toTrackId === track) return `${track} is blocked`
    }
    if (t.kind === 'crew_exception' && d.type === 'car_not_found' && (d.cars as string[] | undefined)?.some((id) => cars.has(id))) {
      return `A crew couldn't find ${(d.cars as string[]).join(', ')}`
    }
    if (t.kind === 'crew_exception' && d.type === 'different_cars' && (d.actual as string[] | undefined)?.some((id) => cars.has(id))) {
      return `A crew moved different cars than the plan said`
    }
    if (t.kind === 'lock_changed' && (d.carId === undefined || cars.has(d.carId as string))) return `A yardmaster changed a lock`
  }
  if (change.type === 'reordered') return 'Knock-on: resequenced around the moves that had to change'
  if (change.fields.includes('train')) return 'Knock-on: cars rolled to another train'
  if (change.type === 'added') return 'Knock-on: new or split move'
  if (change.type === 'removed') return 'Knock-on: no longer needed'
  return 'Knock-on: retargeted to fit the changes above'
}
