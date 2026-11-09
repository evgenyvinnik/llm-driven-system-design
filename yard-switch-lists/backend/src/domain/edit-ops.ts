/**
 * The two things a yardmaster can do to a list: reorder a move or retarget it.
 * Pure, so the live edit path and the replay's scripted yardmaster behave the same.
 * @module domain/edit-ops
 */
import type { PlanMove } from './types.js'

export type EditOp = { op: 'reorder'; moveKey: string; toIndex: number } | { op: 'retarget'; moveKey: string; toTrackId: string }

export function applyOps(moves: PlanMove[], ops: EditOp[]): { moves: PlanMove[]; moved: Set<string>; pins: { before: string; after: string }[] } {
  const list = [...moves]
  const moved = new Set<string>()
  const pins: { before: string; after: string }[] = []
  for (const op of ops) {
    const at = list.findIndex((m) => m.key === op.moveKey)
    if (at < 0) throw new Error(`Move ${op.moveKey} isn't in this list`)
    if (op.op === 'reorder') {
      const [item] = list.splice(at, 1)
      const to = Math.max(0, Math.min(list.length, op.toIndex))
      list.splice(to, 0, item)
      moved.add(item.key)
      const next = list[to + 1]
      if (next) pins.push({ before: item.key, after: next.key })
    } else {
      list[at] = { ...list[at], toTrackId: op.toTrackId }
      moved.add(op.moveKey)
      // The cars now stand somewhere else, so whatever pulls them later has to pull from there.
      if (list[at].kind === 'classify') {
        for (let i = at + 1; i < list.length; i++) {
          if (list[i].fromTrackId && list[i].carIds.some((id) => list[at].carIds.includes(id))) list[i] = { ...list[i], fromTrackId: op.toTrackId }
        }
      }
    }
  }
  return { moves: list, moved, pins }
}
