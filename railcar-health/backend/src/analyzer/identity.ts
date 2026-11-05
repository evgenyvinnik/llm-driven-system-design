/**
 * Identity resolution: map a detector's axle readings (axle N from the head
 * end, north or south rail) to a car and a car-relative bearing position.
 *
 * The consist (train list) from the departure yard says which unit is where
 * and which end leads. It can be stale: a car turned on a wye still shows its
 * old orientation. AEI (RFID) reads at equipped detector sites are ground
 * truth for that pass, so they correct the consist, and earlier passes of the
 * same trip are re-resolved with the corrected orientation.
 * @module analyzer/identity
 */
import type { CarEnd, CarSide, Direction, Rail } from '../shared/domain.js'
import { carRelativePosition } from '../shared/geometry.js'

export interface ConsistUnit {
  position: number
  unitId: string
  unitType: 'locomotive' | 'car'
  axleCount: number
  leadingEnd: CarEnd
}

export interface AeiRead {
  position: number
  unitId: string
  leadingEnd: CarEnd
}

export interface AxleSlot {
  axleSeq: number
  unit: ConsistUnit
  seqInUnit: number
}

export interface ResolvedPosition {
  carId: string
  unitPosition: number
  carAxle: number
  carSide: CarSide
}

export interface Correction {
  position: number
  unitId: string
  leadingEnd: CarEnd
  previousUnitId: string
  previousLeadingEnd: CarEnd
  reason: 'orientation' | 'identity'
}

export function expectedAxleCount(units: ConsistUnit[]): number {
  return units.reduce((sum, u) => sum + u.axleCount, 0)
}

/** Axle sequence numbers (1-based from the head end) to the unit each axle belongs to. */
export function buildAxleMap(units: ConsistUnit[]): AxleSlot[] {
  const slots: AxleSlot[] = []
  const ordered = [...units].sort((a, b) => a.position - b.position)
  let seq = 0
  for (const unit of ordered) {
    for (let i = 1; i <= unit.axleCount; i++) {
      seq += 1
      slots.push({ axleSeq: seq, unit, seqInUnit: i })
    }
  }
  return slots
}

/** Returns null for locomotive axles (monitored by their own systems) and out-of-range axles. */
export function resolveAxle(map: AxleSlot[], axleSeq: number, rail: Rail, direction: Direction): ResolvedPosition | null {
  const slot = map[axleSeq - 1]
  if (!slot || slot.unit.unitType !== 'car') return null
  const { side, axle } = carRelativePosition(rail, direction, slot.unit.leadingEnd, slot.seqInUnit, slot.unit.axleCount)
  return { carId: slot.unit.unitId, unitPosition: slot.unit.position, carAxle: axle, carSide: side }
}

/** AEI reads override the consist for the positions they cover. */
export function applyAeiReads(units: ConsistUnit[], reads: AeiRead[] | null | undefined): { units: ConsistUnit[]; corrections: Correction[] } {
  if (!reads || reads.length === 0) return { units, corrections: [] }
  const byPosition = new Map(reads.map((r) => [r.position, r]))
  const corrections: Correction[] = []
  const corrected = units.map((unit) => {
    const read = byPosition.get(unit.position)
    if (!read || (read.unitId === unit.unitId && read.leadingEnd === unit.leadingEnd)) return unit
    corrections.push({
      position: unit.position,
      unitId: read.unitId,
      leadingEnd: read.leadingEnd,
      previousUnitId: unit.unitId,
      previousLeadingEnd: unit.leadingEnd,
      reason: read.unitId === unit.unitId ? 'orientation' : 'identity',
    })
    return { ...unit, unitId: read.unitId, leadingEnd: read.leadingEnd }
  })
  return { units: corrected, corrections }
}

export type IdentityDecision =
  | { status: 'resolved'; units: ConsistUnit[]; corrections: Correction[] }
  | { status: 'unresolved'; reason: string; units: ConsistUnit[]; corrections: Correction[] }

/**
 * Decides whether a pass can be mapped to cars. An axle count that disagrees
 * with the consist means a car was set out or picked up since departure;
 * guessing would pin readings on the wrong car, so the pass stays unresolved.
 */
export function decideIdentity(units: ConsistUnit[], detectorAxleCount: number, aei: AeiRead[] | null | undefined): IdentityDecision {
  const { units: corrected, corrections } = applyAeiReads(units, aei)
  const expected = expectedAxleCount(corrected)
  if (expected !== detectorAxleCount) {
    return { status: 'unresolved', reason: `axle count ${detectorAxleCount} does not match consist (${expected})`, units: corrected, corrections }
  }
  return { status: 'resolved', units: corrected, corrections }
}

export interface ConsistVersion {
  revision: number
  effectiveAtMs: number
}

/**
 * The consist revision in force when a pass was measured. A train rebuilt at a
 * yard has a new revision from its departure; a late pass from before that is
 * resolved against the old one. Falls back to the first revision.
 */
export function consistRevisionAt(versions: ConsistVersion[], passedAtMs: number): number {
  const sorted = [...versions].sort((a, b) => a.effectiveAtMs - b.effectiveAtMs)
  let chosen = sorted[0]?.revision ?? 1
  for (const v of sorted) if (v.effectiveAtMs <= passedAtMs) chosen = v.revision
  return chosen
}
