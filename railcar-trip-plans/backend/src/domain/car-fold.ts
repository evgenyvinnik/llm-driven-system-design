/**
 * Per-car state as a pure fold over the car's timeline.
 *
 * Why a projection and not an event-sourced aggregate: car movements are facts reported by many producers
 * (AEI readers, yard systems, the train-movement system, another railroad). There is nothing to validate
 * and nothing to reject: a fact arriving late or out of order still happened. So the car has no command
 * side; its state is recomputed from every event about it, sorted by *event time*. The same set of events
 * always gives the same state, whatever order they arrived in, which is what makes late interchange
 * batches, duplicates and replays safe.
 *
 * Missing events: when no car-level read confirms a move, the fold infers it from train movement
 * (TrainDeparted with the car in the consist, then TrainArrived) and marks the position `inferred`. A later
 * read from the yard or an AEI site upgrades it to `observed`. Each train arrival or line passage without a
 * matching read counts as a missed read.
 * @module domain/car-fold
 */
import type { AnyEnvelope, EventEnvelope } from '../shared/events/envelope.js'
import type { Leg } from '../shared/events/schemas.js'
import { HOME_ROAD, lineSiteFor, runInfo, siteById } from '../shared/network.js'

export type CarStatus = 'awaiting_pull' | 'at_yard' | 'in_transit' | 'bad_ordered' | 'off_network' | 'delivered' | 'unknown'
export type Confidence = 'observed' | 'inferred' | 'none'
export type PlanStatus = 'no_plan' | 'on_plan' | 'missed_connection' | 'replanned' | 'complete'

export interface PlanSnapshot {
  tripId: string
  shipperId: string
  version: number
  legs: Leg[]
  originYard: string
  destinationYard: string
  destinationCustomer: string
  handoffRoad: string | null
  releasedAt: string
}

export interface CarState {
  carId: string
  plan: PlanSnapshot | null
  status: CarStatus
  locationId: string | null
  trainRunId: string | null
  positionConfidence: Confidence
  positionSource: string | null
  lastObservedAt: string | null
  lastEventAt: string | null
  /** When the car reached its current yard (or the foreign road). */
  arrivedAt: string | null
  deliveredAt: string | null
  currentLeg: number | null
  planStatus: PlanStatus
  missedReads: number
  lateEvents: number
  outOfOrderEvents: number
  eventCount: number
  foreignRoad: string | null
  /** Bad-order time plus the repair estimate: the car cannot leave before this. */
  repairUntil: string | null
  ridden: string[]
  /** Train events relevant to this car's ETA (runs ridden or in the current plan). */
  delays: Record<string, string>
  cancelled: string[]
  departed: Record<string, string>
  arrived: Record<string, string>
  /** Newest event time among events that matter to this car's state and ETA. */
  asOf: string | null
}

export interface FoldOptions {
  lateAfterMinutes: number
}

const FACT_TYPES = new Set(['CarSighted', 'CarArrivedYard', 'CarDepartedYard', 'CarPlaced', 'CarPulled', 'CarBadOrdered', 'CarInterchanged'])
const TRAIN_TYPES = new Set(['TrainDeparted', 'TrainArrived', 'TrainDelayed', 'TrainCancelled'])

/** Tie-break for events with the same event time: plan first, then departures, then arrivals. */
const RANK: Record<string, number> = {
  TripPlanCreated: 0,
  TripPlanRevised: 0,
  CarPulled: 1,
  TrainDeparted: 2,
  CarDepartedYard: 3,
  CarSighted: 4,
  TrainDelayed: 5,
  TrainCancelled: 5,
  TrainArrived: 6,
  CarArrivedYard: 7,
  CarInterchanged: 8,
  CarBadOrdered: 9,
  CarPlaced: 10,
  ConnectionMissed: 11,
}

export function eventOrder(a: AnyEnvelope, b: AnyEnvelope): number {
  if (a.occurredAt !== b.occurredAt) return a.occurredAt < b.occurredAt ? -1 : 1
  const ra = RANK[a.type] ?? 20
  const rb = RANK[b.type] ?? 20
  if (ra !== rb) return ra - rb
  return a.eventId < b.eventId ? -1 : a.eventId > b.eventId ? 1 : 0
}

const ms = (iso: string) => Date.parse(iso)
const maxIso = (a: string | null, b: string) => (a === null || b > a ? b : a)

function latestPlan(events: AnyEnvelope[]): PlanSnapshot | null {
  let created: EventEnvelope<'TripPlanCreated'> | null = null
  for (const e of events) {
    if (e.type === 'TripPlanCreated') {
      // A car can make many trips; the newest release is the current trip.
      if (!created || e.payload.releasedAt > created.payload.releasedAt) created = e
    }
  }
  if (!created) return null
  const c = created.payload
  let plan: PlanSnapshot = { tripId: c.tripId, shipperId: c.shipperId, version: 1, legs: c.legs, originYard: c.originYard, destinationYard: c.destinationYard, destinationCustomer: c.destinationCustomer, handoffRoad: c.handoffRoad, releasedAt: c.releasedAt }
  for (const e of events) {
    // Plan versions are authoritative by number, not by when the revision event happened.
    if (e.type === 'TripPlanRevised' && e.payload.tripId === c.tripId && e.payload.version > plan.version) {
      plan = { ...plan, version: e.payload.version, legs: e.payload.legs }
    }
  }
  return plan
}

export function foldCar(carId: string, input: AnyEnvelope[], opts: FoldOptions): CarState {
  const plan = latestPlan(input)
  const planRuns = new Set(plan?.legs.map((l) => l.runId) ?? [])
  const events = [...input].sort(eventOrder)

  // Runs this car rode: named in a consist, a yard departure or a line read.
  const ridden = new Set<string>()
  for (const e of events) {
    if (e.type === 'TrainDeparted' && e.payload.consist.includes(carId)) ridden.add(e.payload.runId)
    if (e.type === 'CarDepartedYard' && e.payload.carId === carId) ridden.add(e.payload.trainRunId)
    if (e.type === 'CarSighted' && e.payload.carId === carId && e.payload.trainRunId) ridden.add(e.payload.trainRunId)
  }
  const relevantRun = (runId: string) => ridden.has(runId) || planRuns.has(runId)

  const s: CarState = {
    carId,
    plan,
    status: plan ? 'awaiting_pull' : 'unknown',
    locationId: plan ? plan.originYard : null,
    trainRunId: null,
    positionConfidence: 'none',
    positionSource: null,
    lastObservedAt: null,
    lastEventAt: null,
    arrivedAt: null,
    deliveredAt: null,
    currentLeg: plan ? 0 : null,
    planStatus: plan ? 'on_plan' : 'no_plan',
    missedReads: 0,
    lateEvents: 0,
    outOfOrderEvents: 0,
    eventCount: 0,
    foreignRoad: null,
    repairUntil: null,
    ridden: [...ridden].sort(),
    delays: {},
    cancelled: [],
    departed: {},
    arrived: {},
    asOf: null,
  }

  const observe = (e: AnyEnvelope, patch: Partial<CarState>) => {
    Object.assign(s, patch, { positionConfidence: 'observed', positionSource: e.type })
    s.lastObservedAt = maxIso(s.lastObservedAt, e.occurredAt)
  }
  const infer = (e: AnyEnvelope, patch: Partial<CarState>) => Object.assign(s, patch, { positionConfidence: 'inferred', positionSource: e.type })

  for (const e of events) {
    const isFact = FACT_TYPES.has(e.type)
    const isTrain = TRAIN_TYPES.has(e.type)
    if (isTrain && !relevantRun((e.payload as { runId: string }).runId)) continue
    // asOf covers exactly the event types that trigger an ETA recompute, so a replay sees the same asOf.
    if (isFact || isTrain || e.type === 'TripPlanCreated' || e.type === 'TripPlanRevised') s.asOf = maxIso(s.asOf, e.occurredAt)
    if (isFact || isTrain) s.lastEventAt = maxIso(s.lastEventAt, e.occurredAt)
    // Count only what this projection consumes, so a replay counts the same events the live consumer saw.
    if (isFact || isTrain || e.type === 'TripPlanCreated' || e.type === 'TripPlanRevised' || e.type === 'ConnectionMissed') s.eventCount += 1

    switch (e.type) {
      case 'CarPulled':
        observe(e, { status: 'at_yard', locationId: e.payload.yardId, arrivedAt: e.occurredAt, trainRunId: null })
        break
      case 'CarArrivedYard':
        if (!(s.status === 'at_yard' && s.locationId === e.payload.yardId)) s.arrivedAt = e.occurredAt
        observe(e, { status: s.status === 'bad_ordered' && s.locationId === e.payload.yardId ? 'bad_ordered' : 'at_yard', locationId: e.payload.yardId, trainRunId: null })
        break
      case 'CarDepartedYard':
        observe(e, { status: 'in_transit', locationId: e.payload.yardId, trainRunId: e.payload.trainRunId })
        break
      case 'CarSighted': {
        const p = e.payload
        const site = siteById.get(p.siteId)
        if (p.railroad !== HOME_ROAD) {
          observe(e, { status: s.status === 'delivered' ? 'delivered' : 'off_network', locationId: `${p.railroad}:${p.siteId}`, foreignRoad: p.railroad, trainRunId: null })
        } else if (site?.kind === 'line') {
          observe(e, { status: 'in_transit', locationId: site.fromYard, trainRunId: p.trainRunId ?? s.trainRunId })
        } else if (site?.kind === 'yard_lead' && site.yardId) {
          if (!(s.status === 'at_yard' && s.locationId === site.yardId)) s.arrivedAt = e.occurredAt
          observe(e, { status: 'at_yard', locationId: site.yardId, trainRunId: null })
        }
        break
      }
      case 'TrainDeparted': {
        const p = e.payload
        s.departed[p.runId] = e.occurredAt
        if (p.consist.includes(carId) && !(s.status === 'in_transit' && s.trainRunId === p.runId)) {
          infer(e, { status: 'in_transit', locationId: p.fromYard, trainRunId: p.runId })
        }
        break
      }
      case 'TrainArrived': {
        const p = e.payload
        s.arrived[p.runId] = e.occurredAt
        if (ridden.has(p.runId) && s.status === 'in_transit' && s.trainRunId === p.runId) {
          infer(e, { status: 'at_yard', locationId: p.yardId, trainRunId: null, arrivedAt: e.occurredAt })
        }
        break
      }
      case 'TrainDelayed':
        s.delays[e.payload.runId] = e.payload.newEtaAt
        break
      case 'TrainCancelled':
        if (!s.cancelled.includes(e.payload.runId)) s.cancelled.push(e.payload.runId)
        break
      case 'CarBadOrdered':
        observe(e, { status: 'bad_ordered', locationId: e.payload.yardId, trainRunId: null })
        s.repairUntil = new Date(ms(e.occurredAt) + (e.payload.estimatedRepairHours ?? 24) * 3_600_000).toISOString()
        break
      case 'CarInterchanged': {
        const p = e.payload
        if (p.direction === 'delivered') {
          observe(e, { status: 'off_network', locationId: `${p.toRoad}@${p.interchangePoint}`, foreignRoad: p.toRoad, trainRunId: null, arrivedAt: e.occurredAt })
        } else {
          if (!(s.status === 'at_yard' && s.locationId === p.interchangePoint)) s.arrivedAt = e.occurredAt
          observe(e, { status: 'at_yard', locationId: p.interchangePoint, foreignRoad: null, trainRunId: null })
        }
        break
      }
      case 'CarPlaced':
        observe(e, { status: 'delivered', locationId: e.payload.customerId, trainRunId: null, deliveredAt: e.occurredAt })
        break
      default:
        break
    }
  }
  s.cancelled.sort()

  // Missed reads: a completed train move with no car-level read where one was expected.
  for (const runId of ridden) {
    const arrivedAt = s.arrived[runId]
    const info = runInfo(runId)
    if (!arrivedAt || !info) continue
    const arr = ms(arrivedAt)
    const readAtYard = events.some(
      (e) =>
        ((e.type === 'CarArrivedYard' && e.payload.carId === carId && e.payload.yardId === info.to) ||
          (e.type === 'CarSighted' && e.payload.carId === carId && siteById.get(e.payload.siteId)?.yardId === info.to)) &&
        ms(e.occurredAt) >= arr - 60 * 60_000 &&
        ms(e.occurredAt) <= arr + 12 * 3600_000,
    )
    if (!readAtYard) s.missedReads += 1
    const lineSite = lineSiteFor(info.from, info.to)
    const departedAt = s.departed[runId]
    if (lineSite && departedAt) {
      const seen = events.some((e) => e.type === 'CarSighted' && e.payload.carId === carId && e.payload.siteId === lineSite.siteId && e.occurredAt >= departedAt && e.occurredAt <= arrivedAt)
      if (!seen) s.missedReads += 1
    }
  }

  // Lateness and arrival order, for facts about this car only.
  const facts = input.filter((e) => FACT_TYPES.has(e.type)).sort((a, b) => a.position - b.position)
  let newestSeen = ''
  for (const e of facts) {
    if (ms(e.recordedAt) - ms(e.occurredAt) > opts.lateAfterMinutes * 60_000) s.lateEvents += 1
    if (newestSeen && e.occurredAt < newestSeen && ms(newestSeen) - ms(e.occurredAt) > 60_000) s.outOfOrderEvents += 1
    if (e.occurredAt > newestSeen) newestSeen = e.occurredAt
  }

  // Progress against the plan.
  if (plan) {
    const legIdx = plan.legs.findIndex((l) => !ridden.has(l.runId) || (s.status === 'in_transit' && s.trainRunId === l.runId))
    s.currentLeg = legIdx === -1 ? plan.legs.length : legIdx
    const missed = events.some((e) => e.type === 'ConnectionMissed' && e.payload.tripId === plan.tripId && e.payload.planVersion === plan.version)
    if (s.status === 'delivered' || (s.status === 'off_network' && plan.handoffRoad)) s.planStatus = s.status === 'delivered' ? 'complete' : 'on_plan'
    else if (missed) s.planStatus = 'missed_connection'
    else if (plan.version > 1) s.planStatus = 'replanned'
    else s.planStatus = 'on_plan'
  }
  return s
}
