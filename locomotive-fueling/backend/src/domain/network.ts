/**
 * The demo network: real town names on a simplified, fictional network. Fuel
 * facilities, prices, distances and climbs are illustrative assumptions for
 * learning, not any railroad's actual data.
 *
 * The seed writes this into PostgreSQL. The simulator also imports it as "the
 * world" (physics truth); everything else reads the database.
 * @module domain/network
 */

export interface LocationDef {
  id: string
  name: string
  state: string
  lat: number
  lon: number
}

/** A bidirectional track segment. riseAb is the total feet climbed going a→b (summits included). */
export interface TrackDef {
  a: string
  b: string
  miles: number
  riseAb: number
  riseBa: number
  /** Extra resistance from curvature, lb/ton, averaged over the segment. */
  curveLbPerTon: number
  speedMph: number
  /** No cellular coverage: onboard units buffer readings until they are back in range. */
  dark: boolean
}

export type FuelKind = 'pad' | 'dtl'

export interface FuelOptionDef {
  id: string
  locationId: string
  kind: FuelKind
  vendor: string
  pricePerGal: number
  /** Per-order fee (DTL truck call-out). Pads have none. */
  fee: number
  setupMinutes: number
  pumpGpm: number
  /** DTL trucks must be ordered this many hours before the train arrives. */
  leadTimeHours: number
  cancelFee: number
  /** Trains that can fuel at the same time (fueling tracks at a pad; trucks for DTL). */
  bays: number
}

export interface RouteDef {
  id: string
  name: string
  path: string[]
}

export interface LocoModelDef {
  model: string
  horsepower: number
  tankGal: number
  /** Relative fuel use for the same work (older units burn more). */
  modelFactor: number
}

export const LOCATIONS: LocationDef[] = [
  { id: 'KCK', name: 'Kansas City', state: 'KS', lat: 39.08, lon: -94.65 },
  { id: 'EMP', name: 'Emporia', state: 'KS', lat: 38.4, lon: -96.18 },
  { id: 'WEL', name: 'Wellington', state: 'KS', lat: 37.27, lon: -97.4 },
  { id: 'WAY', name: 'Waynoka', state: 'OK', lat: 36.58, lon: -98.88 },
  { id: 'AMA', name: 'Amarillo', state: 'TX', lat: 35.2, lon: -101.83 },
  { id: 'CLO', name: 'Clovis', state: 'NM', lat: 34.4, lon: -103.2 },
  { id: 'BEL', name: 'Belen', state: 'NM', lat: 34.66, lon: -106.78 },
  { id: 'GAL', name: 'Gallup', state: 'NM', lat: 35.53, lon: -108.74 },
  { id: 'WIN', name: 'Winslow', state: 'AZ', lat: 35.02, lon: -110.7 },
  { id: 'KIN', name: 'Kingman', state: 'AZ', lat: 35.19, lon: -114.05 },
  { id: 'NEE', name: 'Needles', state: 'CA', lat: 34.85, lon: -114.61 },
  { id: 'BAR', name: 'Barstow', state: 'CA', lat: 34.9, lon: -117.02 },
  { id: 'PUR', name: 'Purcell', state: 'OK', lat: 35.01, lon: -97.36 },
  { id: 'FTW', name: 'Fort Worth', state: 'TX', lat: 32.75, lon: -97.33 },
  { id: 'TEM', name: 'Temple', state: 'TX', lat: 31.1, lon: -97.34 },
  { id: 'HOU', name: 'Houston', state: 'TX', lat: 29.76, lon: -95.37 },
  { id: 'SWE', name: 'Sweetwater', state: 'TX', lat: 32.47, lon: -100.41 },
  { id: 'SLA', name: 'Slaton', state: 'TX', lat: 33.44, lon: -101.64 },
]

export const TRACKS: TrackDef[] = [
  { a: 'KCK', b: 'EMP', miles: 110, riseAb: 600, riseBa: 220, curveLbPerTon: 0.4, speedMph: 60, dark: false },
  { a: 'EMP', b: 'WEL', miles: 110, riseAb: 350, riseBa: 250, curveLbPerTon: 0.3, speedMph: 60, dark: false },
  { a: 'WEL', b: 'WAY', miles: 85, riseAb: 450, riseBa: 180, curveLbPerTon: 0.3, speedMph: 60, dark: false },
  { a: 'WAY', b: 'AMA', miles: 200, riseAb: 2300, riseBa: 200, curveLbPerTon: 0.3, speedMph: 60, dark: false },
  { a: 'AMA', b: 'CLO', miles: 105, riseAb: 900, riseBa: 220, curveLbPerTon: 0.3, speedMph: 60, dark: false },
  { a: 'CLO', b: 'BEL', miles: 240, riseAb: 2200, riseBa: 1700, curveLbPerTon: 0.9, speedMph: 45, dark: true },
  { a: 'BEL', b: 'GAL', miles: 140, riseAb: 2700, riseBa: 900, curveLbPerTon: 0.8, speedMph: 45, dark: false },
  { a: 'GAL', b: 'WIN', miles: 125, riseAb: 300, riseBa: 1950, curveLbPerTon: 0.5, speedMph: 55, dark: false },
  { a: 'WIN', b: 'KIN', miles: 200, riseAb: 2400, riseBa: 4300, curveLbPerTon: 0.9, speedMph: 45, dark: true },
  { a: 'KIN', b: 'NEE', miles: 60, riseAb: 200, riseBa: 2900, curveLbPerTon: 0.7, speedMph: 45, dark: false },
  { a: 'NEE', b: 'BAR', miles: 170, riseAb: 2700, riseBa: 1300, curveLbPerTon: 0.5, speedMph: 55, dark: false },
  { a: 'WEL', b: 'PUR', miles: 200, riseAb: 500, riseBa: 400, curveLbPerTon: 0.4, speedMph: 50, dark: false },
  { a: 'PUR', b: 'FTW', miles: 180, riseAb: 400, riseBa: 900, curveLbPerTon: 0.5, speedMph: 50, dark: false },
  { a: 'FTW', b: 'TEM', miles: 130, riseAb: 450, riseBa: 400, curveLbPerTon: 0.4, speedMph: 50, dark: false },
  { a: 'TEM', b: 'HOU', miles: 170, riseAb: 150, riseBa: 800, curveLbPerTon: 0.3, speedMph: 50, dark: false },
  { a: 'FTW', b: 'SWE', miles: 220, riseAb: 1800, riseBa: 300, curveLbPerTon: 0.4, speedMph: 50, dark: false },
  { a: 'SWE', b: 'SLA', miles: 110, riseAb: 800, riseBa: 250, curveLbPerTon: 0.3, speedMph: 50, dark: false },
  { a: 'SLA', b: 'CLO', miles: 110, riseAb: 1700, riseBa: 150, curveLbPerTon: 0.3, speedMph: 50, dark: true },
]

const pad = (id: string, locationId: string, pricePerGal: number, bays = 2): FuelOptionDef => ({
  id,
  locationId,
  kind: 'pad',
  vendor: 'Railroad fuel pad',
  pricePerGal,
  fee: 0,
  setupMinutes: 25,
  pumpGpm: 300,
  leadTimeHours: 0,
  cancelFee: 0,
  bays,
})

const dtl = (id: string, locationId: string, pricePerGal: number, vendor = 'Prairie DTL Services'): FuelOptionDef => ({
  id,
  locationId,
  kind: 'dtl',
  vendor,
  pricePerGal,
  fee: 275,
  setupMinutes: 40,
  pumpGpm: 120,
  leadTimeHours: 6,
  cancelFee: 150,
  bays: 1,
})

/** Prices in $/gal. Illustrative: California pads carry state taxes, contract pads in Texas are cheapest. */
export const FUEL_OPTIONS: FuelOptionDef[] = [
  pad('KCK-PAD', 'KCK', 2.62, 3),
  dtl('EMP-DTL', 'EMP', 2.88),
  dtl('WEL-DTL', 'WEL', 2.83),
  pad('WAY-PAD', 'WAY', 2.59),
  pad('AMA-PAD', 'AMA', 2.55),
  pad('CLO-PAD', 'CLO', 2.6, 1),
  pad('BEL-PAD', 'BEL', 2.57),
  dtl('GAL-DTL', 'GAL', 2.97, 'Mesa Fuel Logistics'),
  dtl('WIN-DTL', 'WIN', 3.02, 'Mesa Fuel Logistics'),
  dtl('KIN-DTL', 'KIN', 3.14, 'Mesa Fuel Logistics'),
  pad('NEE-PAD', 'NEE', 3.28),
  pad('BAR-PAD', 'BAR', 3.39),
  dtl('PUR-DTL', 'PUR', 2.8),
  pad('FTW-PAD', 'FTW', 2.52),
  dtl('TEM-DTL', 'TEM', 2.76),
  pad('HOU-PAD', 'HOU', 2.47),
  dtl('SWE-DTL', 'SWE', 2.71),
]

export const ROUTES: RouteDef[] = [
  { id: 'TRANSCON-W', name: 'Transcon westbound', path: ['KCK', 'EMP', 'WEL', 'WAY', 'AMA', 'CLO', 'BEL', 'GAL', 'WIN', 'KIN', 'NEE', 'BAR'] },
  { id: 'TRANSCON-E', name: 'Transcon eastbound', path: ['BAR', 'NEE', 'KIN', 'WIN', 'GAL', 'BEL', 'CLO', 'AMA', 'WAY', 'WEL', 'EMP', 'KCK'] },
  { id: 'TEXAS-S', name: 'Kansas City to Houston', path: ['KCK', 'EMP', 'WEL', 'PUR', 'FTW', 'TEM', 'HOU'] },
  { id: 'TEXAS-N', name: 'Houston to Kansas City', path: ['HOU', 'TEM', 'FTW', 'PUR', 'WEL', 'EMP', 'KCK'] },
  { id: 'SOUTHERN-W', name: 'Fort Worth to Belen', path: ['FTW', 'SWE', 'SLA', 'CLO', 'BEL'] },
  { id: 'SOUTHERN-E', name: 'Belen to Fort Worth', path: ['BEL', 'CLO', 'SLA', 'SWE', 'FTW'] },
]

/** The detour used by the reroute scenario: Wellington–Waynoka is out of service, so go via Texas. */
export const DETOUR_FROM_WEL = ['WEL', 'PUR', 'FTW', 'SWE', 'SLA', 'CLO', 'BEL', 'GAL', 'WIN', 'KIN', 'NEE', 'BAR']

export const LOCO_MODELS: Record<string, LocoModelDef> = {
  ES44AC: { model: 'ES44AC', horsepower: 4400, tankGal: 5000, modelFactor: 1.0 },
  ET44C4: { model: 'ET44C4', horsepower: 4400, tankGal: 5300, modelFactor: 0.97 },
  SD70ACe: { model: 'SD70ACe', horsepower: 4300, tankGal: 4900, modelFactor: 1.02 },
  AC4400CW: { model: 'AC4400CW', horsepower: 4400, tankGal: 5000, modelFactor: 1.06 },
}

export interface UnitSeed {
  id: string
  model: keyof typeof LOCO_MODELS
  /** Initial fuel as a fraction of the tank. */
  fuel: number
}

export interface TrainSeed {
  id: string
  symbol: string
  routeId: string
  plannedTons: number
  cars: number
  /** Starting position, in miles from the route origin. */
  startMilepost: number
  units: UnitSeed[]
}

export const TRAINS: TrainSeed[] = [
  {
    id: 'T01', symbol: 'Q-KCKBAR', routeId: 'TRANSCON-W', plannedTons: 9800, cars: 110, startMilepost: 40,
    units: [
      { id: '6012', model: 'ES44AC', fuel: 0.82 }, { id: '6013', model: 'ES44AC', fuel: 0.8 },
      { id: '7240', model: 'ET44C4', fuel: 0.84 }, { id: '4521', model: 'AC4400CW', fuel: 0.78 },
    ],
  },
  {
    id: 'T02', symbol: 'Q-BARKCK', routeId: 'TRANSCON-E', plannedTons: 8500, cars: 96, startMilepost: 120,
    units: [{ id: '6101', model: 'ES44AC', fuel: 0.7 }, { id: '6102', model: 'ES44AC', fuel: 0.72 }, { id: '8805', model: 'SD70ACe', fuel: 0.69 }],
  },
  {
    id: 'T03', symbol: 'S-KCKBAR', routeId: 'TRANSCON-W', plannedTons: 11000, cars: 120, startMilepost: 470,
    units: [
      { id: '7301', model: 'ET44C4', fuel: 0.46 }, { id: '7302', model: 'ET44C4', fuel: 0.44 },
      { id: '6150', model: 'ES44AC', fuel: 0.45 }, { id: '4610', model: 'AC4400CW', fuel: 0.47 },
    ],
  },
  {
    id: 'T04', symbol: 'M-HOUKCK', routeId: 'TEXAS-N', plannedTons: 8000, cars: 85, startMilepost: 60,
    units: [{ id: '8810', model: 'SD70ACe', fuel: 0.66 }, { id: '8811', model: 'SD70ACe', fuel: 0.64 }, { id: '4630', model: 'AC4400CW', fuel: 0.67 }],
  },
  {
    id: 'T05', symbol: 'M-KCKHOU', routeId: 'TEXAS-S', plannedTons: 9000, cars: 92, startMilepost: 15,
    units: [{ id: '6205', model: 'ES44AC', fuel: 0.9 }, { id: '6206', model: 'ES44AC', fuel: 0.88 }, { id: '7330', model: 'ET44C4', fuel: 0.91 }],
  },
  {
    id: 'T06', symbol: 'U-FTWBEL', routeId: 'SOUTHERN-W', plannedTons: 13000, cars: 115, startMilepost: 30,
    units: [{ id: '8820', model: 'SD70ACe', fuel: 0.75 }, { id: '8821', model: 'SD70ACe', fuel: 0.74 }, { id: '6230', model: 'ES44AC', fuel: 0.73 }],
  },
  {
    id: 'T07', symbol: 'Q-KCKBAR2', routeId: 'TRANSCON-W', plannedTons: 9200, cars: 104, startMilepost: 5,
    units: [
      { id: '7350', model: 'ET44C4', fuel: 0.95 }, { id: '7351', model: 'ET44C4', fuel: 0.93 },
      { id: '6240', model: 'ES44AC', fuel: 0.94 }, { id: '6241', model: 'ES44AC', fuel: 0.96 },
    ],
  },
  {
    id: 'T08', symbol: 'G-BELFTW', routeId: 'SOUTHERN-E', plannedTons: 7500, cars: 110, startMilepost: 90,
    units: [{ id: '4650', model: 'AC4400CW', fuel: 0.55 }, { id: '4651', model: 'AC4400CW', fuel: 0.52 }, { id: '8830', model: 'SD70ACe', fuel: 0.57 }],
  },
  {
    id: 'T09', symbol: 'Z-BARKCK', routeId: 'TRANSCON-E', plannedTons: 7000, cars: 70, startMilepost: 15,
    units: [
      { id: '7360', model: 'ET44C4', fuel: 0.88 }, { id: '7361', model: 'ET44C4', fuel: 0.86 },
      { id: '6260', model: 'ES44AC', fuel: 0.9 }, { id: '6261', model: 'ES44AC', fuel: 0.87 },
    ],
  },
  {
    id: 'T10', symbol: 'V-KCKHOU', routeId: 'TEXAS-S', plannedTons: 5200, cars: 60, startMilepost: 300,
    units: [{ id: '6270', model: 'ES44AC', fuel: 0.38 }, { id: '6271', model: 'ES44AC', fuel: 0.4 }],
  },
]

export function trackBetween(from: string, to: string): { track: TrackDef; rise: number } {
  const track = TRACKS.find((t) => (t.a === from && t.b === to) || (t.a === to && t.b === from))
  if (!track) throw new Error(`no track between ${from} and ${to}`)
  return { track, rise: track.a === from ? track.riseAb : track.riseBa }
}
