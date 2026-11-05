import { describe, expect, it } from 'vitest'
import { carRelativePosition, detectorViewOf, trainSide } from '../shared/geometry.js'
import { applyAeiReads, buildAxleMap, decideIdentity, resolveAxle, type ConsistUnit } from './identity.js'

const units: ConsistUnit[] = [
  { position: 1, unitId: 'PLNR 4401', unitType: 'locomotive', axleCount: 6, leadingEnd: 'A' },
  { position: 2, unitId: 'NRLX 1', unitType: 'car', axleCount: 4, leadingEnd: 'B' },
  { position: 3, unitId: 'NRLX 2', unitType: 'car', axleCount: 4, leadingEnd: 'A' },
]

describe('rail to train side', () => {
  it('puts the north rail on the left going east and on the right going west', () => {
    expect(trainSide('N', 'EB')).toBe('L')
    expect(trainSide('N', 'WB')).toBe('R')
    expect(trainSide('S', 'EB')).toBe('R')
  })
})

describe('car-relative bearing position', () => {
  it('numbers axles from the B-end and names sides facing the A-end from the B-end', () => {
    // B-end leading eastbound: first axle to reach the detector is axle 1; the north rail is the car's R side.
    expect(carRelativePosition('N', 'EB', 'B', 1, 4)).toEqual({ side: 'R', axle: 1 })
    // A-end leading eastbound: the first axle is axle 4; north rail is the car's L side.
    expect(carRelativePosition('N', 'EB', 'A', 1, 4)).toEqual({ side: 'L', axle: 4 })
  })

  it('keeps a bearing identity stable when the car is turned on a wye', () => {
    // The same physical bearing (R3) seen by the same eastbound detector before and after turning.
    for (const before of ['A', 'B'] as const) {
      const after = before === 'A' ? 'B' : 'A'
      const seenBefore = detectorViewOf('R', 3, 'EB', before, 4)
      const seenAfter = detectorViewOf('R', 3, 'EB', after, 4)
      // Turning moves it to the other rail and the other end of the car...
      expect(seenAfter.rail).not.toBe(seenBefore.rail)
      expect(seenAfter.seqInCar).toBe(5 - seenBefore.seqInCar)
      // ...but resolving each view with the right orientation gives R3 both times.
      expect(carRelativePosition(seenBefore.rail, 'EB', before, seenBefore.seqInCar, 4)).toEqual({ side: 'R', axle: 3 })
      expect(carRelativePosition(seenAfter.rail, 'EB', after, seenAfter.seqInCar, 4)).toEqual({ side: 'R', axle: 3 })
    }
  })

  it('is the inverse of the detector view for every position, direction and orientation', () => {
    for (const dir of ['EB', 'WB'] as const)
      for (const end of ['A', 'B'] as const)
        for (const side of ['L', 'R'] as const)
          for (let axle = 1; axle <= 4; axle++) {
            const view = detectorViewOf(side, axle, dir, end, 4)
            expect(carRelativePosition(view.rail, dir, end, view.seqInCar, 4)).toEqual({ side, axle })
          }
  })
})

describe('axle map', () => {
  it('skips locomotive axles and maps car axles by cumulative count', () => {
    const map = buildAxleMap(units)
    expect(map).toHaveLength(14)
    expect(resolveAxle(map, 6, 'N', 'EB')).toBeNull() // locomotive
    expect(resolveAxle(map, 7, 'N', 'EB')).toEqual({ carId: 'NRLX 1', unitPosition: 2, carAxle: 1, carSide: 'R' })
    expect(resolveAxle(map, 11, 'S', 'EB')).toEqual({ carId: 'NRLX 2', unitPosition: 3, carAxle: 4, carSide: 'R' })
    expect(resolveAxle(map, 99, 'S', 'EB')).toBeNull()
  })
})

describe('AEI corrections', () => {
  it('overrides a stale consist orientation and reports the correction', () => {
    const { units: fixed, corrections } = applyAeiReads(units, [{ position: 3, unitId: 'NRLX 2', leadingEnd: 'B' }])
    expect(fixed[2].leadingEnd).toBe('B')
    expect(corrections).toEqual([{ position: 3, unitId: 'NRLX 2', leadingEnd: 'B', previousUnitId: 'NRLX 2', previousLeadingEnd: 'A', reason: 'orientation' }])
  })

  it('makes no correction when AEI agrees with the consist', () => {
    expect(applyAeiReads(units, units.map((u) => ({ position: u.position, unitId: u.unitId, leadingEnd: u.leadingEnd }))).corrections).toEqual([])
  })

  it('refuses to resolve a pass whose axle count disagrees with the consist', () => {
    const decision = decideIdentity(units, 18, null)
    expect(decision.status).toBe('unresolved')
    expect(decideIdentity(units, 14, null).status).toBe('resolved')
  })
})

describe('consist revision by time', () => {
  it('resolves a pass against the consist in force when it was measured, even if it arrives after a rebuild', async () => {
    const { consistRevisionAt } = await import('./identity.js')
    const versions = [{ revision: 1, effectiveAtMs: 0 }, { revision: 2, effectiveAtMs: 1000 }]
    expect(consistRevisionAt(versions, 500)).toBe(1) // a late pass from before the train was rebuilt
    expect(consistRevisionAt(versions, 1500)).toBe(2)
    expect(consistRevisionAt(versions, -10)).toBe(1) // clock skew before departure: first revision
  })
})
