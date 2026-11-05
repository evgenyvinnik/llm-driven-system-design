/**
 * Component lifecycle filtering. The car is not its wheelsets: after a wheelset
 * is replaced, readings measured (event time) before the install belong to the
 * old wheelset. They stay stored as history but never count as evidence
 * against the new one, however late they arrive (processing time).
 * @module analyzer/components
 */

/** car_id|axle -> install time (ms) of the wheelset currently on that axle. */
export type InstallCutoffs = Map<string, number>

export const axleKey = (carId: string, axle: number) => `${carId}|${axle}`

export interface Install {
  carId: string
  axle: number
  installedAtMs: number
  removedAtMs: number | null
}

/** Rebuilds "what is on each axle now" from install/remove events, in any order. */
export function currentInstalls(events: Install[]): InstallCutoffs {
  const out: InstallCutoffs = new Map()
  for (const e of events) {
    if (e.removedAtMs !== null) continue
    const key = axleKey(e.carId, e.axle)
    out.set(key, Math.max(out.get(key) ?? 0, e.installedAtMs))
  }
  return out
}

/** Keeps readings measured on the currently installed wheelset; returns the rest separately. */
export function splitByInstall<T extends { carId: string; carAxle: number; passedAtMs: number }>(rows: T[], cutoffs: InstallCutoffs): { current: T[]; previous: T[] } {
  const current: T[] = []
  const previous: T[] = []
  for (const r of rows) {
    const cutoff = cutoffs.get(axleKey(r.carId, r.carAxle))
    if (cutoff !== undefined && r.passedAtMs < cutoff) previous.push(r)
    else current.push(r)
  }
  return { current, previous }
}
