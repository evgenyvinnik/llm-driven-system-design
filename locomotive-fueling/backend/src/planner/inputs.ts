/**
 * Builds optimizer inputs from loaded data. Pure, so it can be tested without
 * a database: the train, its path legs, unit states, fuel options, existing
 * DTL orders and parameters go in; PlanInputs come out.
 * @module planner/inputs
 */
import { forecastBurn, nodeMileposts, reserveGallons, unitShares, type Leg } from '../domain/consumption.js'
import type { ModelParams } from '../domain/params.js'
import type { FuelOptionRow, LocationRow, TrainRow } from '../shared/repo.js'
import type { LocoState } from '../shared/state.js'
import type { FuelChoice, PlanInputs, PlanUnit, RoutePoint } from './types.js'

export interface OrderLite {
  stopKey: string
  optionId: string
  status: string
  attempts: number
}

export const stopKeyFor = (trainId: string, locationId: string, optionId: string) => `${trainId}:${locationId}:${optionId}`

export interface AssembleArgs {
  train: TrainRow
  legs: Leg[]
  states: Map<string, LocoState>
  options: FuelOptionRow[]
  orders: OrderLite[]
  params: ModelParams
  locations: Map<string, LocationRow>
  nowMs: number
  /** Plan against zero reserve (emergency mode, after the normal plan proved infeasible). */
  zeroReserve?: boolean
}

export interface Assembled {
  inputs: PlanInputs
  currentMilepost: number
  trainCalibration: number
}

export function assembleInputs(a: AssembleArgs): Assembled {
  const { train, legs, states, params } = a
  const lead = train.units.find((u) => u.role === 'lead') ?? train.units[0]
  const leadState = lead ? states.get(lead.locomotiveId) : undefined
  const totalMiles = legs.length ? legs[legs.length - 1].endMile : 0
  const currentMilepost = Math.min(totalMiles, leadState?.milepost ?? train.lastMilepost)
  const stopped = (leadState?.speedMph ?? 0) < 1

  const calibrations = train.units.map((u) => {
    const s = states.get(u.locomotiveId)
    return s && !s.sensorSuspect ? s.calibration : 1
  })
  const shares = unitShares(train.units.map((u, i) => ({ horsepower: u.horsepower, modelFactor: u.modelFactor, calibration: calibrations[i], online: u.online })))
  const units: PlanUnit[] = train.units.map((u, i) => ({
    locomotiveId: u.locomotiveId,
    capacityGal: u.tankGal,
    fuelGal: states.get(u.locomotiveId)?.fuelGal ?? u.tankGal * 0.5,
    reserveGal: a.zeroReserve ? 0 : reserveGallons(u.tankGal, params.reservePct, params.reserveMinGal),
    share: shares[i],
  }))
  const healthy = train.units.filter((u) => {
    const s = states.get(u.locomotiveId)
    return s && !s.sensorSuspect && !s.leakSuspect
  })
  const trainCalibration = healthy.length ? healthy.reduce((s, u) => s + (states.get(u.locomotiveId)?.calibration ?? 1), 0) / healthy.length : 1

  const nodes = nodeMileposts(legs)
  const ahead = nodes.filter((n) => (stopped ? n.milepost >= currentMilepost - 0.5 : n.milepost > currentMilepost + 0.05))
  const ordersByKey = new Map(a.orders.map((o) => [o.stopKey, o]))
  const n = train.units.length

  let hoursSoFar = forecastBurn(legs, currentMilepost, ahead[0]?.milepost ?? currentMilepost, train.plannedTons, n).hours
  const points: RoutePoint[] = ahead.map((node, i) => {
    const next = ahead[i + 1]
    const leg = next ? forecastBurn(legs, node.milepost, next.milepost, train.plannedTons, n) : { gallons: 0, hours: 0 }
    const etaMs = a.nowMs + hoursSoFar * 3_600_000
    hoursSoFar += leg.hours
    const isDestination = i === ahead.length - 1
    const options: FuelChoice[] = isDestination
      ? []
      : a.options
          .filter((o) => o.locationId === node.locationId)
          .map((o) => {
            const order = ordersByKey.get(stopKeyFor(train.id, o.locationId, o.id))
            const live = order && (order.status === 'unknown' || order.status === 'confirmed' || (order.status === 'pending' && order.attempts > 0))
            const dead = order && ['rejected', 'failed', 'cancelled', 'cancel_requested'].includes(order.status)
            const hoursAway = (etaMs - a.nowMs) / 3_600_000
            let unavailableReason: string | undefined
            if (!o.active) unavailableReason = 'facility inactive'
            else if (dead) unavailableReason = `DTL order ${order!.status} earlier this trip`
            else if (o.kind === 'dtl' && !order && hoursAway < o.leadTimeHours) unavailableReason = `needs ${o.leadTimeHours} h notice, train is ${hoursAway.toFixed(1)} h away`
            return {
              optionId: o.id,
              locationId: o.locationId,
              kind: o.kind,
              pricePerGal: o.pricePerGal,
              fee: o.fee,
              setupMinutes: o.setupMinutes,
              pumpGpm: o.pumpGpm,
              leadTimeHours: o.leadTimeHours,
              cancelFee: o.cancelFee,
              committed: Boolean(live),
              available: !unavailableReason,
              unavailableReason,
            }
          })
    return {
      locationId: node.locationId,
      name: a.locations.get(node.locationId)?.name ?? node.locationId,
      milepost: node.milepost,
      etaMs,
      burnToNext: leg.gallons,
      options,
    }
  })

  const destination = train.path[train.path.length - 1]
  const destPad = a.options.find((o) => o.locationId === destination && o.kind === 'pad' && o.active)
  return {
    inputs: {
      nowMs: a.nowMs,
      currentMilepost,
      burnToFirst: ahead.length ? forecastBurn(legs, currentMilepost, ahead[0].milepost, train.plannedTons, n).gallons : 0,
      units,
      points,
      params: {
        gridGal: params.gridGal,
        safetyMarginPct: params.safetyMarginPct,
        delayCostPerHour: params.delayCostPerHour,
        stopPenalty: params.stopPenalty,
        valueRemainingFuel: params.valueRemainingFuel,
      },
      destinationPricePerGal: destPad ? Math.max(0, destPad.pricePerGal - params.terminalDiscountPerGal) : null,
    },
    currentMilepost,
    trainCalibration,
  }
}
