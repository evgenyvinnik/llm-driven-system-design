/**
 * Read helpers shared by the api, processor and planner: the network, trains
 * with their consists, fuel options and model parameters.
 * @module shared/repo
 */
import type { FuelKind } from '../domain/network.js'
import type { TrackLike } from '../domain/consumption.js'
import { mergeParams, type ModelParams } from '../domain/params.js'
import { pool, type Queryable } from './db.js'

export interface LocationRow {
  id: string
  name: string
  state: string
  lat: number
  lon: number
}

export interface FuelOptionRow {
  id: string
  locationId: string
  kind: FuelKind
  vendor: string
  pricePerGal: number
  fee: number
  setupMinutes: number
  pumpGpm: number
  leadTimeHours: number
  cancelFee: number
  bays: number
  active: boolean
  updatedAt: string
}

export interface ConsistUnitRow {
  locomotiveId: string
  model: string
  horsepower: number
  tankGal: number
  modelFactor: number
  position: number
  role: 'lead' | 'trailing' | 'dp'
  online: boolean
}

export interface TrainRow {
  id: string
  symbol: string
  routeId: string
  path: string[]
  plannedTons: number
  cars: number
  status: 'running' | 'arrived'
  departedAt: string
  arrivedAt: string | null
  lastMilepost: number
  lastLocation: string | null
  pathVersion: number
  units: ConsistUnitRow[]
}

let tracksCache: TrackLike[] | null = null
let locationsCache: Map<string, LocationRow> | null = null

export async function loadTracks(db: Queryable = pool): Promise<TrackLike[]> {
  if (tracksCache) return tracksCache
  const { rows } = await db.query(
    `SELECT a, b, miles, rise_ab AS "riseAb", rise_ba AS "riseBa", curve_lb_per_ton AS "curveLbPerTon", speed_mph AS "speedMph", dark FROM tracks`,
  )
  tracksCache = rows as TrackLike[]
  return tracksCache
}

export async function loadLocations(db: Queryable = pool): Promise<Map<string, LocationRow>> {
  if (locationsCache) return locationsCache
  const { rows } = await db.query<LocationRow>('SELECT id, name, state, lat, lon FROM locations')
  locationsCache = new Map(rows.map((r) => [r.id, r]))
  return locationsCache
}

/** Test hook and seed hook: forget cached static data. */
export function clearStaticCaches(): void {
  tracksCache = null
  locationsCache = null
}

export async function loadFuelOptions(db: Queryable = pool): Promise<FuelOptionRow[]> {
  const { rows } = await db.query(
    `SELECT id, location_id AS "locationId", kind, vendor, price_per_gal::float AS "pricePerGal", fee::float AS fee,
            setup_minutes AS "setupMinutes", pump_gpm AS "pumpGpm", lead_time_hours AS "leadTimeHours",
            cancel_fee::float AS "cancelFee", bays, active, updated_at AS "updatedAt"
       FROM fuel_options ORDER BY id`,
  )
  return rows as FuelOptionRow[]
}

export async function loadParams(db: Queryable = pool): Promise<ModelParams> {
  const { rows } = await db.query<{ key: string; value: unknown }>('SELECT key, value FROM model_params')
  return mergeParams(rows)
}

const TRAIN_SELECT = `
  SELECT t.id, t.symbol, t.route_id AS "routeId", t.path, t.planned_tons AS "plannedTons", t.cars, t.status,
         t.departed_at AS "departedAt", t.arrived_at AS "arrivedAt", t.last_milepost AS "lastMilepost",
         t.last_location AS "lastLocation", t.path_version AS "pathVersion",
         COALESCE(json_agg(json_build_object(
           'locomotiveId', l.id, 'model', l.model, 'horsepower', l.horsepower, 'tankGal', l.tank_gal,
           'modelFactor', l.model_factor, 'position', c.position, 'role', c.role, 'online', c.online
         ) ORDER BY c.position) FILTER (WHERE l.id IS NOT NULL), '[]') AS units
    FROM trains t
    LEFT JOIN consist_units c ON c.train_id = t.id
    LEFT JOIN locomotives l ON l.id = c.locomotive_id`

export async function loadTrain(id: string, db: Queryable = pool): Promise<TrainRow | null> {
  const { rows } = await db.query(`${TRAIN_SELECT} WHERE t.id = $1 GROUP BY t.id`, [id])
  return (rows[0] as TrainRow) ?? null
}

export async function loadTrains(opts: { status?: 'running' | 'arrived'; ids?: string[] } = {}, db: Queryable = pool): Promise<TrainRow[]> {
  const where: string[] = []
  const args: unknown[] = []
  if (opts.status) {
    args.push(opts.status)
    where.push(`t.status = $${args.length}`)
  }
  if (opts.ids) {
    args.push(opts.ids)
    where.push(`t.id = ANY($${args.length})`)
  }
  const { rows } = await db.query(
    `${TRAIN_SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} GROUP BY t.id ORDER BY t.status DESC, t.id`,
    args,
  )
  return rows as TrainRow[]
}
