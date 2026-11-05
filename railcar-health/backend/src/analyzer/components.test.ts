import { describe, expect, it } from 'vitest'
import { currentInstalls, splitByInstall } from './components.js'

const H = 3_600_000

describe('component lifecycle', () => {
  it('rebuilds what is on each axle now from install and remove events, in any order', () => {
    const cutoffs = currentInstalls([
      { carId: 'SVTX 961204', axle: 4, installedAtMs: 5 * H, removedAtMs: null },
      { carId: 'SVTX 961204', axle: 4, installedAtMs: 1 * H, removedAtMs: 5 * H },
      { carId: 'SVTX 961204', axle: 1, installedAtMs: 2 * H, removedAtMs: null },
    ])
    expect(cutoffs.get('SVTX 961204|4')).toBe(5 * H)
    expect(cutoffs.get('SVTX 961204|1')).toBe(2 * H)
    expect(cutoffs.has('SVTX 961204|2')).toBe(false)
  })

  it('never uses a reading taken before the replacement as evidence, however late it arrives', () => {
    // The wheelset on axle 1 was replaced at 10:00. A detector reconnects at 11:00 and uploads a hot
    // reading measured at 09:00: it belongs to the old wheelset.
    const cutoffs = currentInstalls([{ carId: 'C1', axle: 1, installedAtMs: 10 * H, removedAtMs: null }])
    const rows = [
      { carId: 'C1', carAxle: 1, passedAtMs: 9 * H, bearingF: 190 },
      { carId: 'C1', carAxle: 1, passedAtMs: 10.5 * H, bearingF: 101 },
      { carId: 'C1', carAxle: 2, passedAtMs: 9 * H, bearingF: 99 },
    ]
    const { current, previous } = splitByInstall(rows, cutoffs)
    expect(previous).toEqual([rows[0]])
    expect(current).toEqual([rows[1], rows[2]])
  })
})
