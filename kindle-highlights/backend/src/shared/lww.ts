/**
 * Field-level last-writer-wins merge for highlight edits made on different devices.
 *
 * A highlight has one owner, so conflicts only happen when the same reader edits it on two
 * devices before they sync. Each mutable field carries the stamp of the edit that set it
 * ({ts, device}); an incoming edit wins a field only if its stamp is newer. Edits to different
 * fields therefore both survive (color on the Kindle, note on the phone), and only true
 * same-field conflicts are decided by time, with the device id as a deterministic tie-break.
 * Deletes are handled by the caller: a tombstoned highlight accepts no further edits.
 *
 * @module shared/lww
 */

export const MUTABLE_FIELDS = ['note', 'color', 'visibility'] as const
export type MutableField = (typeof MUTABLE_FIELDS)[number]

/** Stamp of the edit that last set a field. */
export interface FieldStamp {
  ts: number
  device: string
}

export type FieldClock = Partial<Record<MutableField, FieldStamp>>
export type MutableValues = Record<MutableField, string | null>

/**
 * How far ahead of the server a device clock may claim to be. A device whose clock is set to
 * next year would otherwise win every conflict forever; clamped, it wins for at most this long.
 */
export const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000

export interface MergeInput {
  current: MutableValues
  clock: FieldClock
  changes: Partial<MutableValues>
  /** The device's wall-clock time when the edit was made (epoch ms). */
  clientTs: number
  deviceId: string
  serverNow: number
}

export interface MergeResult {
  next: MutableValues
  clock: FieldClock
  /** Fields this edit changed. */
  applied: MutableField[]
  /** Fields where a newer edit had already won. */
  superseded: MutableField[]
}

function sameStamp(a: FieldStamp, b: FieldStamp | undefined): boolean {
  return b !== undefined && a.ts === b.ts && a.device === b.device
}

/** Clamps a device timestamp so a fast clock cannot dominate future edits. */
export function effectiveTimestamp(clientTs: number, serverNow: number): number {
  return Math.min(clientTs, serverNow + MAX_CLOCK_SKEW_MS)
}

/** True when stamp `a` should overwrite a field last written with stamp `b`. */
export function stampWins(a: FieldStamp, b: FieldStamp | undefined): boolean {
  if (!b) return true
  if (a.ts !== b.ts) return a.ts > b.ts
  // Same millisecond: the higher device id wins, so every replica picks the same winner.
  // A replay from the same device re-applies, which is harmless.
  return a.device >= b.device
}

/** Merges one edit into the current field values, field by field. */
export function mergeFieldUpdates(input: MergeInput): MergeResult {
  const stamp: FieldStamp = { ts: effectiveTimestamp(input.clientTs, input.serverNow), device: input.deviceId }
  const next: MutableValues = { ...input.current }
  const clock: FieldClock = { ...input.clock }
  const applied: MutableField[] = []
  const superseded: MutableField[] = []

  for (const field of MUTABLE_FIELDS) {
    if (!(field in input.changes)) continue
    const value = input.changes[field] ?? null
    if (!stampWins(stamp, clock[field])) {
      superseded.push(field)
    } else if (value !== next[field] || !sameStamp(stamp, clock[field])) {
      next[field] = value
      clock[field] = stamp
      applied.push(field)
    }
    // else: the same edit replayed (same device, same time, same value), nothing to do
  }
  return { next, clock, applied, superseded }
}

/** The clock written when a highlight is created: every mutable field stamped by the creator. */
export function initialClock(clientTs: number, deviceId: string, serverNow: number): FieldClock {
  const stamp: FieldStamp = { ts: effectiveTimestamp(clientTs, serverNow), device: deviceId }
  return Object.fromEntries(MUTABLE_FIELDS.map((field) => [field, stamp])) as FieldClock
}
