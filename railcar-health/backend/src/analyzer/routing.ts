/**
 * Where an alert goes. The same tier means different things depending on
 * where the train is now: a MEDIUM computed from data that arrived two hours
 * late, after the train reached its yard, is a job for that yard's car
 * inspectors before the car leaves again, not a message to a dispatcher about
 * a train that has already stopped.
 * @module analyzer/routing
 */
import { TIER, type Direction } from '../shared/domain.js'
import { subdivisionAt, SUBDIVISIONS, type Yard } from '../shared/network.js'

export type Routing = 'dispatcher_and_yard' | 'yard' | 'yard_post_arrival' | 'owner_only'

export interface TripState {
  status: 'en_route' | 'arrived'
  direction: Direction
  stops: string[]
  arrivedYardId: string | null
  speedMph: number
  lastMilepost: number | null
  lastPassAtMs: number | null
  destinationMp: number
  originMp: number
}

export interface RouteDecision {
  routing: Routing
  deskId: string | null
  territoryId: string | null
  yardId: string | null
  late: boolean
  lagMinutes: number
  note: string
}

export function isLate(lagSeconds: number, lateAfterMinutes: number): boolean {
  return lagSeconds > lateAfterMinutes * 60
}

/** Dead reckoning from the newest detector pass; clamped to the trip's end points. */
export function estimateMilepost(trip: TripState, nowMs: number): number | null {
  if (trip.lastMilepost === null || trip.lastPassAtMs === null) return null
  const hours = Math.max(0, nowMs - trip.lastPassAtMs) / 3_600_000
  const travelled = hours * trip.speedMph
  const sign = trip.direction === 'EB' ? 1 : -1
  const estimate = trip.lastMilepost + sign * travelled
  const lo = Math.min(trip.originMp, trip.destinationMp)
  const hi = Math.max(trip.originMp, trip.destinationMp)
  return Math.min(hi, Math.max(lo, estimate))
}

/** First yard on the trip's stop list that is still ahead of the train. */
export function predictNextYard(
  trip: Pick<TripState, 'direction' | 'stops' | 'speedMph'>,
  milepost: number,
  yards: Yard[],
): { yard: Yard; etaMinutes: number } | null {
  const ahead = trip.stops
    .map((id) => yards.find((y) => y.id === id))
    .filter((y): y is Yard => y !== undefined)
    .find((y) => (trip.direction === 'EB' ? y.milepost >= milepost : y.milepost <= milepost))
  if (!ahead) return null
  const miles = Math.abs(ahead.milepost - milepost)
  return { yard: ahead, etaMinutes: trip.speedMph > 0 ? (miles / trip.speedMph) * 60 : 0 }
}

export function routeAlert(input: {
  tier: number
  lagSeconds: number
  lateAfterMinutes: number
  trip: TripState
  nowMs: number
  yards: Yard[]
  readingMilepost: number
}): RouteDecision {
  const { tier, trip } = input
  const late = isLate(input.lagSeconds, input.lateAfterMinutes)
  const lagMinutes = Math.round(input.lagSeconds / 60)
  const lateText = late ? `Data is ${lagMinutes} min old. ` : ''

  if (trip.status === 'arrived') {
    const yardId = trip.arrivedYardId
    if (tier >= TIER.MEDIUM) {
      return {
        routing: 'yard_post_arrival',
        deskId: null,
        territoryId: null,
        yardId,
        late,
        lagMinutes,
        note: `${lateText}Train has already arrived at ${yardId}: hold the car and inspect before it is released.`,
      }
    }
    return { routing: 'owner_only', deskId: null, territoryId: null, yardId, late, lagMinutes, note: `${lateText}Train has arrived; notify the car owner and monitor.` }
  }

  const position = estimateMilepost(trip, input.nowMs) ?? input.readingMilepost
  const territory = subdivisionAt(position)
  const next = predictNextYard(trip, position, input.yards)
  const yardId = next?.yard.id ?? null
  const behind = Math.abs(position - input.readingMilepost)
  const movedText = late && behind >= 1 ? `Train is now about ${Math.round(behind)} mi past the reading, near MP ${Math.round(position)}. ` : ''
  const eta = next ? ` (ETA ${Math.round(next.etaMinutes)} min)` : ''

  if (tier >= TIER.HIGH) {
    const ask = tier === TIER.CRITICAL ? 'Stop and inspect.' : 'Set out at the next siding or run at restricted speed to the next inspection point.'
    return {
      routing: 'dispatcher_and_yard',
      deskId: territory.deskId,
      territoryId: territory.id,
      yardId,
      late,
      lagMinutes,
      note: `${lateText}${movedText}${ask} Mechanical forces at ${yardId ?? 'destination'}${eta} notified.`,
    }
  }
  if (tier === TIER.MEDIUM) {
    return {
      routing: 'yard',
      deskId: territory.deskId,
      territoryId: territory.id,
      yardId,
      late,
      lagMinutes,
      note: `${lateText}${movedText}Inspect at ${yardId ?? 'the next terminal'}${eta}; car held until inspected.`,
    }
  }
  return {
    routing: 'owner_only',
    deskId: territory.deskId,
    territoryId: territory.id,
    yardId,
    late,
    lagMinutes,
    note: `${lateText}Monitor; car owner notified for planned maintenance.`,
  }
}

export const deskForSubdivision = (id: string) => SUBDIVISIONS.find((s) => s.id === id)?.deskId ?? null
