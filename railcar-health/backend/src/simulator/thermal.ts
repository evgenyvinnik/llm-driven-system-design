/**
 * Thermal model for one train passing one detector. Bearing temperature =
 * ambient + running heat (speed, load) + sun on the south side by day + braking
 * zone + the bearing's own running offset + noise + any injected defect. The
 * detector's calibration bias is applied to what it measures, and the detector
 * raises its own alarm from the measured value, as a real one would.
 */
import type { Direction, Rail } from '../shared/domain.js'
import { carRelativePosition } from '../shared/geometry.js'
import type { SimUnit } from './fleet.js'
import { gaussian, stableGaussian, type Rng } from './rng.js'

export interface DefectSpec {
  carId: string
  position: string
  /** Extra °F on the bearing as a function of miles travelled since origin and the detector milepost. */
  bearingDelta: (distance: number, milepost: number) => number
}

export interface PassSpec {
  units: SimUnit[]
  direction: Direction
  distance: number
  milepost: number
  speedMph: number
  ambientF: number
  hourOfDay: number
  brakingZone: boolean
  biasF: number
  defects: DefectSpec[]
  stuckBrakeCars: Set<string>
  /** Cars whose brakes don't apply: their wheels stay cool in braking zones. */
  inoperativeBrakeCars: Set<string>
  /** The site's own absolute alarm (illustrative), °F above ambient. */
  siteAlarmAboveAmbient: number
}

export interface SimReading {
  seq: number
  rail: Rail
  bearingF: number
  wheelF: number
}

const r1 = (n: number) => Math.round(n * 10) / 10

export function generateReadings(spec: PassSpec, rng: Rng): { axles: SimReading[]; edgeAlarms: Array<{ axleSeq: number; rail: Rail; kind: 'hot_bearing' }> } {
  const axles: SimReading[] = []
  const edgeAlarms: Array<{ axleSeq: number; rail: Rail; kind: 'hot_bearing' }> = []
  const daylight = spec.hourOfDay >= 10 && spec.hourOfDay <= 17
  let seq = 0
  for (const unit of spec.units) {
    for (let inUnit = 1; inUnit <= unit.axleCount; inUnit++) {
      seq += 1
      for (const rail of ['N', 'S'] as Rail[]) {
        let bearing: number
        let wheel: number
        if (unit.unitType === 'locomotive') {
          bearing = spec.ambientF + 48 + gaussian(rng) * 4
          wheel = spec.ambientF + 20 + gaussian(rng) * 5
        } else {
          const { side, axle } = carRelativePosition(rail, spec.direction, unit.leadingEnd, inUnit, unit.axleCount)
          const pos = `${side}${axle}`
          const running = 15 + 0.5 * spec.speedMph + (unit.loaded ? 6 : 0)
          const sun = daylight && rail === 'S' ? 6 : 0
          const braking = spec.brakingZone ? 6 : 0
          const individual = stableGaussian(`${unit.unitId}:${pos}`, 3.5)
          const defect = spec.defects.filter((d) => d.carId === unit.unitId && d.position === pos).reduce((s, d) => s + d.bearingDelta(spec.distance, spec.milepost), 0)
          const stuck = spec.stuckBrakeCars.has(unit.unitId)
          const braked = spec.brakingZone && !spec.inoperativeBrakeCars.has(unit.unitId)
          bearing = spec.ambientF + running + sun + braking + individual + gaussian(rng) * 3 + defect + (stuck ? 10 : 0)
          wheel = spec.ambientF + 12 + (braked ? 90 + gaussian(rng) * 15 : gaussian(rng) * 6) + (stuck ? 200 + gaussian(rng) * 12 : 0)
        }
        const measuredBearing = bearing + spec.biasF
        if (measuredBearing - spec.ambientF >= spec.siteAlarmAboveAmbient) edgeAlarms.push({ axleSeq: seq, rail, kind: 'hot_bearing' })
        axles.push({ seq, rail, bearingF: r1(measuredBearing), wheelF: r1(wheel + spec.biasF) })
      }
    }
  }
  return { axles, edgeAlarms }
}
