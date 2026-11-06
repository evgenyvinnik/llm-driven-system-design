/**
 * The event catalog in code: for each type, which topic it is published to, which stream it is appended
 * to, and its partition key. Car facts, plan events and every decision about a car share the `car` topic
 * keyed by car id, so one partition sees everything about a car in order. Train facts are keyed by train
 * run. (events.md is the human-readable version of this file.)
 * @module shared/events/catalog
 */
import type { Topic } from '../config.js'
import type { EventType, Payloads } from './schemas.js'

export type Origin = 'external' | 'internal'

interface CatalogEntry<T extends EventType> {
  topic: Topic
  origin: Origin
  stream: (p: Payloads[T]) => string
  key: (p: Payloads[T]) => string
  /** Car ids the event names directly (indexed in event_cars). */
  cars: (p: Payloads[T]) => string[]
}

type Catalog = { [T in EventType]: CatalogEntry<T> }

const carFact = <T extends 'CarSighted' | 'CarArrivedYard' | 'CarDepartedYard' | 'CarPlaced' | 'CarPulled' | 'CarBadOrdered' | 'CarInterchanged'>(): CatalogEntry<T> => ({
  topic: 'car',
  origin: 'external',
  stream: (p) => `car-${p.carId}`,
  key: (p) => p.carId,
  cars: (p) => [p.carId],
})

const trainFact = <T extends 'TrainDeparted' | 'TrainArrived' | 'TrainDelayed' | 'TrainCancelled'>(): CatalogEntry<T> => ({
  topic: 'train',
  origin: 'external',
  stream: (p) => `train-${p.runId}`,
  key: (p) => p.runId,
  cars: () => [],
})

const sagaEvent = <T extends 'ReplanStarted' | 'TrainCapacityReserved' | 'TrainCapacityReleased' | 'ReplanCompleted' | 'ReplanFailed' | 'ReplanCompensated'>(): CatalogEntry<T> => ({
  topic: 'car',
  origin: 'internal',
  stream: (p) => `replan-${p.sagaId}`,
  key: (p) => p.carId,
  cars: (p) => [p.carId],
})

export const CATALOG: Catalog = {
  CarSighted: carFact(),
  CarArrivedYard: carFact(),
  CarDepartedYard: carFact(),
  CarPlaced: carFact(),
  CarPulled: carFact(),
  CarBadOrdered: carFact(),
  CarInterchanged: carFact(),
  TrainDeparted: { ...trainFact<'TrainDeparted'>(), cars: (p) => p.consist },
  TrainArrived: trainFact(),
  TrainDelayed: trainFact(),
  TrainCancelled: trainFact(),
  TripPlanCreated: { topic: 'car', origin: 'internal', stream: (p) => `plan-${p.tripId}`, key: (p) => p.carId, cars: (p) => [p.carId] },
  TripPlanRevised: { topic: 'car', origin: 'internal', stream: (p) => `plan-${p.tripId}`, key: (p) => p.carId, cars: (p) => [p.carId] },
  ConnectionMissed: { topic: 'car', origin: 'internal', stream: (p) => `carstate-${p.carId}`, key: (p) => p.carId, cars: (p) => [p.carId] },
  EtaUpdated: { topic: 'car', origin: 'internal', stream: (p) => `eta-${p.carId}`, key: (p) => p.carId, cars: (p) => [p.carId] },
  ExceptionOpened: { topic: 'car', origin: 'internal', stream: (p) => `exception-${p.exceptionId}`, key: (p) => p.carId, cars: (p) => [p.carId] },
  ExceptionResolved: { topic: 'car', origin: 'internal', stream: (p) => `exception-${p.exceptionId}`, key: (p) => p.carId, cars: (p) => [p.carId] },
  ReplanStarted: sagaEvent(),
  TrainCapacityReserved: sagaEvent(),
  TrainCapacityReleased: sagaEvent(),
  ReplanCompleted: sagaEvent(),
  ReplanFailed: sagaEvent(),
  ReplanCompensated: sagaEvent(),
  ClockTicked: { topic: 'train', origin: 'internal', stream: () => 'clock', key: () => 'clock', cars: () => [] },
  ShipperNotified: { topic: 'shipper', origin: 'internal', stream: (p) => `shipper-${p.shipperId}`, key: (p) => p.shipperId, cars: (p) => p.carIds },
}

export function routeOf<T extends EventType>(type: T, payload: Payloads[T]) {
  const entry = CATALOG[type] as CatalogEntry<T>
  return { topic: entry.topic, streamId: entry.stream(payload), partitionKey: entry.key(payload), cars: entry.cars(payload), origin: entry.origin }
}

/** Natural dedupe key for facts from the field: catches a resend that carries a new event id. */
export function naturalKey(type: EventType, payload: Record<string, unknown>, occurredAt: string): string | null {
  const minute = occurredAt.slice(0, 16)
  switch (type) {
    case 'CarSighted':
      return `${type}|${payload.carId}|${payload.siteId}|${minute}`
    case 'CarArrivedYard':
    case 'CarBadOrdered':
      return `${type}|${payload.carId}|${payload.yardId}|${minute}`
    case 'CarDepartedYard':
      return `${type}|${payload.carId}|${payload.trainRunId}`
    case 'CarPlaced':
    case 'CarPulled':
      return `${type}|${payload.carId}|${payload.customerId}|${minute}`
    case 'CarInterchanged':
      return `${type}|${payload.carId}|${payload.interchangePoint}|${payload.direction}|${minute}`
    case 'TrainDeparted':
    case 'TrainArrived':
    case 'TrainCancelled':
      return `${type}|${payload.runId}`
    case 'TrainDelayed':
      return `${type}|${payload.runId}|${payload.newEtaAt}`
    default:
      return null
  }
}
