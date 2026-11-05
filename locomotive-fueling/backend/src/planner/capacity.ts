/**
 * Shared fuel pad capacity. Each train is planned on its own, but against the
 * slots other trains have already reserved by accepting their plans: if every
 * bay is taken when this train would arrive, the expected wait is added to
 * that option's dwell and delay cost, so the optimizer naturally looks
 * elsewhere when a pad is congested. Recommendations reserve nothing; only an
 * accepted stop holds a bay.
 * @module planner/capacity
 */

export interface Slot {
  start: number
  end: number
}

/**
 * Minutes this train would wait for a free bay if it arrived at `eta` and
 * needed `dwellMinutes`. Greedy simulation: take the earliest moment at which
 * fewer than `bays` reservations overlap the whole stay.
 */
export function queueWaitMinutes(reserved: Slot[], etaMs: number, dwellMinutes: number, bays: number): number {
  const dwellMs = dwellMinutes * 60_000
  const overlapping = (t: number) => reserved.filter((s) => s.start < t + dwellMs && s.end > t).length
  let t = etaMs
  // Candidate start times are the ETA and each reservation's end.
  const ends = reserved.map((s) => s.end).filter((e) => e > etaMs).sort((a, b) => a - b)
  for (let i = 0; overlapping(t) >= bays && i <= ends.length; i++) t = ends[i] ?? t
  return Math.max(0, (t - etaMs) / 60_000)
}

/** Whether a new reservation for [start, end] fits in a pad with `bays` bays. */
export function fits(reserved: Slot[], start: number, end: number, bays: number): boolean {
  // The peak overlap inside the window happens at some reservation start (or the window start).
  const points = [start, ...reserved.map((s) => s.start).filter((t) => t > start && t < end)]
  return points.every((p) => reserved.filter((s) => s.start <= p && s.end > p).length < bays)
}
