/**
 * The simulated railroad: one east-west line, Harlow (MP 0) to Ridgeway
 * (MP 240), in three subdivisions covered by two dispatcher desks. Hot bearing
 * detectors sit roughly every 15 miles; some sites also have AEI (RFID) readers;
 * two sit at the bottom of grades where braking warms every wheel and bearing.
 * The seed script loads this into PostgreSQL and the simulator drives it.
 * @module shared/network
 */

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
export interface Yard {
  id: string
  name: string
  milepost: number
  subdivisionId: string
}
export interface DetectorSite {
  id: string
  name: string
  milepost: number
  subdivisionId: string
  hasAei: boolean
  brakingZone: boolean
  gatewayId: string
}

export const DESKS: Desk[] = [
  { id: 'WEST', name: 'West Desk' },
  { id: 'EAST', name: 'East Desk' },
]

export const SUBDIVISIONS: Subdivision[] = [
  { id: 'HARLOW', name: 'Harlow Sub', startMp: 0, endMp: 80, deskId: 'WEST' },
  { id: 'PRAIRIE', name: 'Prairie Sub', startMp: 80, endMp: 160, deskId: 'WEST' },
  { id: 'RIDGEWAY', name: 'Ridgeway Sub', startMp: 160, endMp: 240.01, deskId: 'EAST' },
]

export const YARDS: Yard[] = [
  { id: 'HAR', name: 'Harlow Yard', milepost: 0, subdivisionId: 'HARLOW' },
  { id: 'CDJ', name: 'Cedar Junction Yard', milepost: 118, subdivisionId: 'PRAIRIE' },
  { id: 'RDG', name: 'Ridgeway Yard', milepost: 240, subdivisionId: 'RIDGEWAY' },
]

const SITES: Array<[number, string, { aei?: boolean; braking?: boolean }]> = [
  [10, 'Alder', {}],
  [25, 'Birch Creek', { aei: true }],
  [40, 'Cole', {}],
  [55, 'Dunmore Hill', { braking: true }],
  [70, 'Elkhorn', { aei: true }],
  [85, 'Fairview', {}],
  [100, 'Granger', { aei: true }],
  [112, 'Hollis', {}],
  [126, 'Ivanhoe', {}],
  [140, 'Juniper', {}],
  [155, 'Kessler', { aei: true }],
  [170, 'Lyle', {}],
  [185, 'Marten Grade', { braking: true }],
  [200, 'Norwood', {}],
  [215, 'Orrin', { aei: true }],
  [230, 'Pike', {}],
]

export function subdivisionAt(milepost: number): Subdivision {
  return SUBDIVISIONS.find((s) => milepost >= s.startMp && milepost < s.endMp) ?? SUBDIVISIONS[SUBDIVISIONS.length - 1]
}

export const DETECTORS: DetectorSite[] = SITES.map(([mp, name, opts]) => {
  const code = String(mp).padStart(3, '0')
  return {
    id: `HBD-${code}`,
    name,
    milepost: mp,
    subdivisionId: subdivisionAt(mp).id,
    hasAei: opts.aei === true,
    brakingZone: opts.braking === true,
    gatewayId: `GW-${code}`,
  }
})

export function yardById(id: string): Yard | undefined {
  return YARDS.find((y) => y.id === id)
}
