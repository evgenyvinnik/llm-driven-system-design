/**
 * The simulated railroad: two subdivisions of a fictional line (Plains &
 * Northern, "P&N"), cut into 10-mile track segments. Each segment has one edge
 * gateway that buffers and forwards its sensors' events. The track segment is
 * the partition key for edge and hazard events.
 *
 * Every location, sensor and number here is an illustrative assumption.
 * The seed writes this registry to PostgreSQL; ingest and the correlator read
 * the database copy, so a sensor can be registered at runtime.
 * @module shared/track
 */

export type SensorType = 'geophone' | 'slide_fence' | 'camera' | 'rail_temp' | 'water_level'

export interface Desk {
  id: string
  name: string
}

export interface Subdivision {
  id: string
  name: string
  startMp: number
  endMp: number
  deskId: string
}

export interface Segment {
  id: string
  subdivisionId: string
  startMp: number
  endMp: number
  gatewayId: string
}

export interface Sensor {
  id: string
  type: SensorType
  subdivisionId: string
  segmentId: string
  milepost: number
  gatewayId: string
  /** Rail neutral temperature for rail_temp sensors (°F). */
  neutralTempF?: number
  label?: string
}

export const DESKS: Desk[] = [
  { id: 'WEST', name: 'West desk (Canyon Sub)' },
  { id: 'EAST', name: 'East desk (Prairie Sub)' },
]

export const SUBDIVISIONS: Subdivision[] = [
  { id: 'CAN', name: 'Canyon Subdivision', startMp: 100, endMp: 180, deskId: 'WEST' },
  { id: 'PRA', name: 'Prairie Subdivision', startMp: 180, endMp: 260, deskId: 'EAST' },
]

export const SEGMENT_MILES = 10

export const SEGMENTS: Segment[] = SUBDIVISIONS.flatMap((sub) => {
  const out: Segment[] = []
  for (let mp = sub.startMp, i = 1; mp < sub.endMp; mp += SEGMENT_MILES, i++) {
    out.push({ id: `${sub.id}-${i}`, subdivisionId: sub.id, startMp: mp, endMp: Math.min(mp + SEGMENT_MILES, sub.endMp), gatewayId: `GW-${sub.id}-${i}` })
  }
  return out
})

export function subdivisionAt(mp: number): Subdivision | undefined {
  return SUBDIVISIONS.find((s) => mp >= s.startMp && mp < s.endMp) ?? (mp === SUBDIVISIONS.at(-1)?.endMp ? SUBDIVISIONS.at(-1) : undefined)
}

export function segmentAt(subdivisionId: string, mp: number): Segment | undefined {
  const segs = SEGMENTS.filter((s) => s.subdivisionId === subdivisionId)
  return segs.find((s) => mp >= s.startMp && mp < s.endMp) ?? (mp === segs.at(-1)?.endMp ? segs.at(-1) : undefined)
}

/** Segments whose span touches [mp - radius, mp + radius]: the correlator locks all of them (the "halo"). */
export function segmentsNear(subdivisionId: string, mp: number, radius: number): Segment[] {
  return SEGMENTS.filter((s) => s.subdivisionId === subdivisionId && s.endMp >= mp - radius && s.startMp <= mp + radius)
}

const PREFIX: Record<SensorType, string> = { geophone: 'GEO', slide_fence: 'FNC', camera: 'CAM', rail_temp: 'RTS', water_level: 'WTR' }

function sensor(type: SensorType, milepost: number, label?: string, neutralTempF?: number): Sensor {
  const sub = subdivisionAt(milepost)
  if (!sub) throw new Error(`milepost ${milepost} is off the line`)
  const seg = segmentAt(sub.id, milepost)!
  return { id: `${PREFIX[type]}-${milepost.toFixed(1)}`, type, subdivisionId: sub.id, segmentId: seg.id, milepost, gatewayId: seg.gatewayId, label, neutralTempF }
}

const GEOPHONES = [
  104.5, 112.6, 114.8, 117.1, 122.0, 131.8, 133.9, 135.9, 141.0, 146.2, 147.9, 149.7, 155.0, 163.9, 165.4, 165.7, 167.5, 174.0,
  186.6, 195.0, 200.1, 213.8, 222.0, 228.3, 241.5, 248.0, 253.0,
]
const FENCES = [113.0, 115.5, 132.5, 134.8, 146.8, 147.8, 150.2, 164.5, 166.7]
const CAMERAS: Array<[number, string]> = [
  [136.2, 'Tunnel 3 east portal'],
  [186.4, 'Co. Rd 14 crossing'],
  [199.8, 'Hwy 52 crossing'],
  [213.5, 'Elm St crossing'],
  [228.1, 'Co. Rd 30 crossing'],
  [241.3, 'Hwy 9 crossing'],
  [252.7, 'Mill Rd crossing'],
]
const WATER: Array<[number, string]> = [
  [124.6, 'Bridge 124.6 (Rock Creek)'],
  [171.2, 'Bridge 171.2 (Canyon River)'],
  [207.9, 'Culvert 207.9'],
  [236.4, 'Culvert 236.4'],
]

/** Rail neutral temperature varies with how and when the rail was laid; illustrative values. */
const NEUTRAL_TEMPS = [95, 98, 92, 96, 100, 94, 97, 95, 96, 93, 95, 98, 94, 96, 95, 97]

export const SENSORS: Sensor[] = [
  ...SEGMENTS.map((seg, i) => sensor('rail_temp', seg.startMp + 5, undefined, NEUTRAL_TEMPS[i % NEUTRAL_TEMPS.length])),
  ...GEOPHONES.map((mp) => sensor('geophone', mp)),
  ...FENCES.map((mp) => sensor('slide_fence', mp, 'Slide fence')),
  ...CAMERAS.map(([mp, label]) => sensor('camera', mp, label)),
  ...WATER.map(([mp, label]) => sensor('water_level', mp, label)),
]

export const SENSOR_BY_ID = new Map(SENSORS.map((s) => [s.id, s]))
export const SEGMENT_BY_ID = new Map(SEGMENTS.map((s) => [s.id, s]))
export const SUBDIVISION_BY_ID = new Map(SUBDIVISIONS.map((s) => [s.id, s]))
export const GATEWAY_SEGMENT = new Map(SEGMENTS.map((s) => [s.gatewayId, s]))

/** A geophone installed in the field but not yet in the registry: its readings dead-letter until ops registers it. */
export const UNREGISTERED_SENSOR = { id: 'GEO-118.9', type: 'geophone' as const, milepost: 118.9, subdivisionId: 'CAN', segmentId: 'CAN-2', gatewayId: 'GW-CAN-2' }
