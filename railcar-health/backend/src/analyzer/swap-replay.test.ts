import { describe, expect, it } from 'vitest'
import { DEFAULT_THRESHOLDS } from '../shared/domain.js'
import { currentInstalls } from './components.js'
import { scoreTripPure } from './pipeline.js'
import type { PassContext, ReadingRow } from './trend.js'

// The follow-up, re-derived from facts alone: a reading measured at 10:00 arrives at 12:00 (backfill),
// and the wheelset on HPRX 1's axle 2 was replaced at 11:00. HPRX 2 had no replacement.
const PASSED = Date.parse('2026-11-05T10:00:00Z')
const INSTALLED = Date.parse('2026-11-05T11:00:00Z')
const pass: PassContext = { detectorId: 'HBD-100', passId: 'P1', milepost: 100, passedAtMs: PASSED, ambientF: 55, biasOffsetF: 0, lagSeconds: 7200, edgeAlarmKeys: new Set(), brakingZone: false }

function readings(): ReadingRow[] {
  const rows: ReadingRow[] = []
  let seq = 0
  for (let car = 1; car <= 10; car++) {
    for (let axle = 1; axle <= 4; axle++) {
      seq += 1
      for (const side of ['L', 'R'] as const) {
        const hot = (car === 1 || car === 2) && axle === 2 && side === 'L'
        rows.push({ detectorId: 'HBD-100', passId: 'P1', axleSeq: seq, rail: side === 'L' ? 'S' : 'N', bearingF: hot ? 162 : 100 + (seq % 3), wheelF: 70, carId: `HPRX ${car}`, carSide: side, carAxle: axle, passedAtMs: PASSED })
      }
    }
  }
  return rows
}

const score = (rows: ReadingRow[], installs: Array<{ carId: string; axle: number; installedAtMs: number; removedAtMs: null }>) =>
  scoreTripPure({ passes: new Map([['HBD-100|P1', pass]]), rows, cutoffs: currentInstalls(installs), history: new Map(), originMp: 0, thresholds: DEFAULT_THRESHOLDS })

const alerted = (r: ReturnType<typeof score>) => r.candidates.filter((c) => c.kind === 'hot_bearing' && c.score.tier > 0).map((c) => `${c.carId} ${c.position}`).sort()

describe('late reading after a wheelset swap, decided from events alone', () => {
  it('without the install both hot bearings alert', () => {
    expect(alerted(score(readings(), []))).toEqual(['HPRX 1 L2', 'HPRX 2 L2'])
  })

  it('with the install, the replaced wheelset is not blamed; its reading is kept as history of the old one', () => {
    const r = score(readings(), [{ carId: 'HPRX 1', axle: 2, installedAtMs: INSTALLED, removedAtMs: null }])
    expect(alerted(r)).toEqual(['HPRX 2 L2'])
    expect(r.replacedKeys.has('HPRX 1|L2') && r.replacedKeys.has('HPRX 1|R2')).toBe(true)
    expect(r.previous).toHaveLength(2)
  })

  it('an install AFTER the reading in event time does not exclude it only if it went on later than the reading', () => {
    const before = score(readings(), [{ carId: 'HPRX 1', axle: 2, installedAtMs: PASSED - 3_600_000, removedAtMs: null }])
    expect(alerted(before)).toEqual(['HPRX 1 L2', 'HPRX 2 L2'])
  })

  it('gives the same decision whatever order the facts are replayed in (arrival order is irrelevant)', () => {
    const install = [{ carId: 'HPRX 1', axle: 2, installedAtMs: INSTALLED, removedAtMs: null as null }]
    const shuffled = readings().sort((a, b) => ((a.axleSeq * 7919 + a.rail.charCodeAt(0)) % 13) - ((b.axleSeq * 7919 + b.rail.charCodeAt(0)) % 13))
    const a = score(readings(), install)
    const b = score(shuffled, install)
    expect(alerted(b)).toEqual(alerted(a))
    expect(b.candidates.find((c) => c.carId === 'HPRX 2' && c.position === 'L2')?.features.sideDelta).toBeCloseTo(a.candidates.find((c) => c.carId === 'HPRX 2' && c.position === 'L2')!.features.sideDelta)
  })
})
