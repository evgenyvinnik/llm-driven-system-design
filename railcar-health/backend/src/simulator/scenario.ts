/**
 * The demo scenario: five trains over about eight simulated hours, with the
 * faults the design has to survive.
 *
 *   M-HARRID  EB  a bearing (NRLX 304512 R3) heating slowly from MP 0: trending
 *                 flags it ~150 miles before the absolute alarm would.
 *   M-RIDHAR  WB  NRLX 220187 was turned on the wye; the consist still has the
 *                 old orientation. Its warm L2 bearing only matches the car's
 *                 history once the first AEI read corrects the orientation.
 *   Q-HARCDJ  EB  SVTX 961204 L1 jumps at HBD-112, whose gateway is offline; the
 *                 data arrives after the train reached Cedar Junction.
 *   G-RIDHAR  WB  a stuck brake on PLNR 504433 (hot wheels).
 *   Z-HARRID  EB  control train with one warm-but-healthy bearing (TCLX 118840 R2).
 *
 * Detector faults: HBD-140 reads 20°F low (calibration drift), HBD-170 is
 * silent (heartbeats fine, records nothing), HBD-112's gateway loses its link
 * and later delivers its buffered passes out of order, then retries them.
 */
import type { Direction } from '../shared/domain.js'
import type { CarEnd } from '../shared/domain.js'
import type { DefectSpec } from './thermal.js'

export interface TrainSpec {
  symbol: string
  direction: Direction
  originYardId: string
  destinationYardId: string
  stops: string[]
  departMinutes: number
  speedMph: number
  locomotives: number
  cars: number
  seed: number
  special: Array<{ index: number; carId: string; leadingEnd: CarEnd; consistLeadingEnd?: CarEnd }>
  defects: DefectSpec[]
  stuckBrakeCars: string[]
}

export interface Faults {
  biasedDetectors: Record<string, number>
  silentDetectors: string[]
  gatewayOutages: Array<{ detectorId: string; fromMinutes: number; toMinutes: number }>
  duplicateRate: number
}

/** Dwell at an intermediate yard (crew change, inspection). */
export const DWELL_MINUTES = 30
/** Each detector site's own alarm, °F above ambient. Illustrative, not a regulatory value. */
export const SITE_ALARM_ABOVE_AMBIENT = 195

export const TRAINS: TrainSpec[] = [
  {
    symbol: 'M-HARRID', direction: 'EB', originYardId: 'HAR', destinationYardId: 'RDG', stops: ['CDJ', 'RDG'], departMinutes: 5, speedMph: 45,
    locomotives: 3, cars: 80, seed: 11,
    special: [{ index: 23, carId: 'NRLX 304512', leadingEnd: 'B' }],
    defects: [{ carId: 'NRLX 304512', position: 'R3', bearingDelta: (d) => 5 + 0.38 * d + 0.00135 * d * d }],
    stuckBrakeCars: [],
  },
  {
    symbol: 'M-RIDHAR', direction: 'WB', originYardId: 'RDG', destinationYardId: 'HAR', stops: ['CDJ', 'HAR'], departMinutes: 25, speedMph: 47,
    locomotives: 2, cars: 70, seed: 22,
    special: [{ index: 40, carId: 'NRLX 220187', leadingEnd: 'B', consistLeadingEnd: 'A' }],
    defects: [{ carId: 'NRLX 220187', position: 'L2', bearingDelta: () => 17 }],
    stuckBrakeCars: [],
  },
  {
    symbol: 'Q-HARCDJ', direction: 'EB', originYardId: 'HAR', destinationYardId: 'CDJ', stops: ['CDJ'], departMinutes: 50, speedMph: 50,
    locomotives: 2, cars: 60, seed: 33,
    special: [{ index: 15, carId: 'SVTX 961204', leadingEnd: 'A' }],
    defects: [{ carId: 'SVTX 961204', position: 'L1', bearingDelta: (d) => (d >= 105 ? 52 : 3) }],
    stuckBrakeCars: [],
  },
  {
    symbol: 'G-RIDHAR', direction: 'WB', originYardId: 'RDG', destinationYardId: 'HAR', stops: ['CDJ', 'HAR'], departMinutes: 95, speedMph: 40,
    locomotives: 3, cars: 90, seed: 44,
    special: [{ index: 60, carId: 'PLNR 504433', leadingEnd: 'A' }],
    defects: [],
    stuckBrakeCars: ['PLNR 504433'],
  },
  {
    symbol: 'Z-HARRID', direction: 'EB', originYardId: 'HAR', destinationYardId: 'RDG', stops: ['RDG'], departMinutes: 125, speedMph: 55,
    locomotives: 2, cars: 65, seed: 55,
    special: [{ index: 30, carId: 'TCLX 118840', leadingEnd: 'B' }],
    defects: [{ carId: 'TCLX 118840', position: 'R2', bearingDelta: () => 18 }],
    stuckBrakeCars: [],
  },
]

export const FAULTS: Faults = {
  biasedDetectors: { 'HBD-140': -20 },
  silentDetectors: ['HBD-170'],
  gatewayOutages: [{ detectorId: 'HBD-112', fromMinutes: 105, toMinutes: 255 }],
  duplicateRate: 0.05,
}
