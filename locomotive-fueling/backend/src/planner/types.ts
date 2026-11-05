/**
 * Planner input and output types. The planner is pure: plan-service.ts loads
 * these inputs from PostgreSQL and Valkey, and persists the result.
 * @module planner/types
 */
import type { FuelKind } from '../domain/network.js'

export interface PlanUnit {
  locomotiveId: string
  capacityGal: number
  fuelGal: number
  reserveGal: number
  /** Share of the train's forecast burn this unit consumes (horsepower share × model × calibration). */
  share: number
}

export interface FuelChoice {
  optionId: string
  locationId: string
  kind: FuelKind
  pricePerGal: number
  fee: number
  setupMinutes: number
  pumpGpm: number
  leadTimeHours: number
  cancelFee: number
  /** A DTL order already exists for this stop: skipping it costs the cancellation fee. */
  committed: boolean
  /** False when the option can't be used (inactive, too late to order a truck, vendor refused). */
  available: boolean
  unavailableReason?: string
  /** Expected wait for a free bay at the ETA, from other trains' accepted reservations. */
  queueMinutes?: number
}

/** A node on the remaining path. The last point is the destination. */
export interface RoutePoint {
  locationId: string
  name: string
  milepost: number
  etaMs: number
  /** Nominal forecast train burn from this point to the next one, train-gallons. */
  burnToNext: number
  options: FuelChoice[]
}

export interface OptimizerParams {
  gridGal: number
  safetyMarginPct: number
  delayCostPerHour: number
  stopPenalty: number
  valueRemainingFuel: boolean
}

export interface PlanInputs {
  nowMs: number
  currentMilepost: number
  /** Nominal forecast train burn from the current position to the first point. */
  burnToFirst: number
  units: PlanUnit[]
  points: RoutePoint[]
  params: OptimizerParams
  /** Price used to value fuel left over at the destination; null when it has no pad. */
  destinationPricePerGal: number | null
}

/** What a plan prescribes at a stop: per-unit target levels, in gallons. */
export interface StopSpec {
  locationId: string
  optionId: string
  targets: Record<string, number>
}

export interface UnitFill {
  locomotiveId: string
  arrivalGal: number
  targetGal: number
  gallons: number
}

export interface SimStop {
  seq: number
  locationId: string
  name: string
  optionId: string
  kind: FuelKind
  milepost: number
  etaMs: number
  gallons: number
  perUnit: UnitFill[]
  pricePerGal: number
  fuelCost: number
  fee: number
  delayCost: number
  dwellMinutes: number
  queueMinutes: number
  committed: boolean
}

export interface CostBreakdown {
  fuel: number
  fees: number
  delay: number
  stops: number
  cancellations: number
  terminalCredit: number
  total: number
}

export interface ProfilePoint {
  milepost: number
  locationId: string | null
  fuelGal: number
  kind: 'start' | 'arrive' | 'depart'
}

export interface SimResult {
  feasible: boolean
  breach: { locationId: string; name: string; milepost: number; headroomGal: number } | null
  unavailable: string[]
  stops: SimStop[]
  cost: CostBreakdown
  profile: ProfilePoint[]
  /** Smallest headroom above reserve at any node, train-gallons. */
  minHeadroom: number
  reserveTotalGal: number
  capacityTotalGal: number
}
