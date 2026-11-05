/**
 * Turns train specs into a time-ordered list of events in simulated minutes.
 */
import { DETECTORS, yardById, type DetectorSite } from '../shared/network.js'
import { DWELL_MINUTES, type TrainSpec } from './scenario.js'

export type SimEvent =
  | { at: number; kind: 'consist'; train: TrainSpec }
  | { at: number; kind: 'departed'; train: TrainSpec }
  | { at: number; kind: 'pass'; train: TrainSpec; detector: DetectorSite; distance: number }
  | { at: number; kind: 'arrived'; train: TrainSpec; yardId: string }

/** Minutes after departure at which the train reaches a milepost, including dwell at intermediate stops passed. */
export function minutesTo(train: TrainSpec, milepost: number): number {
  const origin = yardById(train.originYardId)!.milepost
  const distance = Math.abs(milepost - origin)
  const dwells = train.stops
    .slice(0, -1)
    .map((id) => yardById(id)!)
    .filter((y) => Math.abs(y.milepost - origin) < distance).length
  return (distance / train.speedMph) * 60 + dwells * DWELL_MINUTES
}

export function buildTimeline(trains: TrainSpec[]): SimEvent[] {
  const events: SimEvent[] = []
  for (const train of trains) {
    const origin = yardById(train.originYardId)!.milepost
    const destination = yardById(train.destinationYardId)!.milepost
    const lo = Math.min(origin, destination)
    const hi = Math.max(origin, destination)
    events.push({ at: train.departMinutes - 5, kind: 'consist', train })
    events.push({ at: train.departMinutes, kind: 'departed', train })
    for (const detector of DETECTORS.filter((d) => d.milepost > lo && d.milepost < hi)) {
      events.push({ at: train.departMinutes + minutesTo(train, detector.milepost), kind: 'pass', train, detector, distance: Math.abs(detector.milepost - origin) })
    }
    events.push({ at: train.departMinutes + minutesTo(train, destination), kind: 'arrived', train, yardId: train.destinationYardId })
  }
  return events.sort((a, b) => a.at - b.at)
}
