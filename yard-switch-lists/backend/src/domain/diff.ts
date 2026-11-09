/**
 * Compare two ordered move lists by stable move key. A move is identical when
 * its cars and tracks are; "reordered" comes from the longest increasing
 * subsequence of old positions, i.e. the fewest moves you'd have to pick up
 * and re-insert, so one insertion doesn't count every later move as changed.
 * @module domain/diff
 */
import type { MoveDiffCounts, PlanMove } from './types.js'

const sameCars = (a: string[], b: string[]): boolean => {
  if (a.length !== b.length) return false
  const set = new Set(a)
  for (const id of b) if (!set.has(id)) return false
  return true
}

export function sameContent(a: PlanMove, b: PlanMove): boolean {
  return a.fromTrackId === b.fromTrackId && a.toTrackId === b.toTrackId && a.outboundId === b.outboundId && sameCars(a.carIds, b.carIds)
}

/** Length of the longest strictly increasing subsequence, O(n log n). */
export function lisLength(values: number[]): number {
  const tails: number[] = []
  for (const v of values) {
    let lo = 0
    let hi = tails.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (tails[mid] < v) lo = mid + 1
      else hi = mid
    }
    tails[lo] = v
  }
  return tails.length
}

/** The set of positions in `values` that sit on one LIS; everything else counts as reordered. */
function lisMembers(values: number[]): Set<number> {
  const tails: number[] = []
  const tailIdx: number[] = []
  const prev = new Array<number>(values.length).fill(-1)
  values.forEach((v, i) => {
    let lo = 0
    let hi = tails.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (tails[mid] < v) lo = mid + 1
      else hi = mid
    }
    tails[lo] = v
    tailIdx[lo] = i
    prev[i] = lo > 0 ? tailIdx[lo - 1] : -1
  })
  const keep = new Set<number>()
  let at = tailIdx.length ? tailIdx[tailIdx.length - 1] : -1
  while (at >= 0) {
    keep.add(at)
    at = prev[at]
  }
  return keep
}

export function countDisturbed(before: PlanMove[], after: PlanMove[], ignore?: Set<string>): MoveDiffCounts {
  const oldIndex = new Map<string, number>()
  before.forEach((m, i) => oldIndex.set(m.key, i))
  const seen = new Set<string>()
  let changed = 0
  let added = 0
  let retimed = 0
  const ranks: number[] = []
  for (const m of after) {
    if (ignore?.has(m.key)) {
      seen.add(m.key)
      continue
    }
    const i = oldIndex.get(m.key)
    if (i === undefined) {
      added++
      continue
    }
    seen.add(m.key)
    if (!sameContent(before[i], m)) changed++
    else {
      ranks.push(i)
      if (Math.abs(before[i].plannedStart - m.plannedStart) > 60_000) retimed++
    }
  }
  let removed = 0
  for (const m of before) if (!seen.has(m.key) && !ignore?.has(m.key)) removed++
  const lis = lisLength(ranks)
  const reordered = ranks.length - lis
  return {
    kept: lis,
    changed,
    reordered,
    added,
    removed,
    retimed,
    disturbed: changed + reordered + added + removed,
  }
}

export interface MoveChange {
  key: string
  type: 'kept' | 'changed' | 'reordered' | 'added' | 'removed'
  fields: string[]
  before: PlanMove | null
  after: PlanMove | null
  shiftMin: number
}

/** The full per-move diff the plan page shows. Counts agree with `countDisturbed`. */
export function diffMoves(before: PlanMove[], after: PlanMove[]): { changes: MoveChange[]; counts: MoveDiffCounts } {
  const oldIndex = new Map<string, number>()
  before.forEach((m, i) => oldIndex.set(m.key, i))
  const seen = new Set<string>()
  const changes: MoveChange[] = []
  const candidates: { change: MoveChange; rank: number }[] = []
  for (const m of after) {
    const i = oldIndex.get(m.key)
    if (i === undefined) {
      changes.push({ key: m.key, type: 'added', fields: [], before: null, after: m, shiftMin: 0 })
      continue
    }
    seen.add(m.key)
    const b = before[i]
    const shiftMin = Math.round((m.plannedStart - b.plannedStart) / 60_000)
    if (!sameContent(b, m)) {
      const fields: string[] = []
      if (b.toTrackId !== m.toTrackId) fields.push('toTrack')
      if (b.fromTrackId !== m.fromTrackId) fields.push('fromTrack')
      if (b.outboundId !== m.outboundId) fields.push('train')
      if (!sameCars(b.carIds, m.carIds)) fields.push('cars')
      changes.push({ key: m.key, type: 'changed', fields, before: b, after: m, shiftMin })
    } else {
      const change: MoveChange = { key: m.key, type: 'kept', fields: [], before: b, after: m, shiftMin }
      candidates.push({ change, rank: i })
      changes.push(change)
    }
  }
  const members = lisMembers(candidates.map((c) => c.rank))
  candidates.forEach((c, i) => {
    if (!members.has(i)) {
      c.change.type = 'reordered'
      c.change.fields = ['order']
    }
  })
  for (const m of before) {
    if (!seen.has(m.key)) changes.push({ key: m.key, type: 'removed', fields: [], before: m, after: null, shiftMin: 0 })
  }
  return { changes, counts: countDisturbed(before, after) }
}
