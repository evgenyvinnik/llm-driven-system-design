/**
 * A small hand-built yard for tests, plus move builders. The plan below is valid
 * on purpose; each validator test breaks exactly one rule in it.
 */
import { DEFAULT_RULES, MIN } from '../domain/params.js'
import type { CarState, LockDef, PlanMove, YardSnapshot } from '../domain/types.js'

export const T0 = Date.UTC(2026, 10, 9, 6, 0, 0)

export function car(id: string, blockId: string, over: Partial<CarState> = {}): CarState {
  return {
    id,
    lengthFt: 50,
    tons: 100,
    blockId,
    hazmatClass: null,
    inboundId: 'I1',
    consistPos: Number(id.replace(/\D/g, '')) || 0,
    position: 'on_track',
    trackId: 'R1',
    held: false,
    coupledTo: null,
    coupledSeq: null,
    arrivedAt: T0 - 60 * MIN,
    ...over,
  }
}

export function yard(over: Partial<YardSnapshot> = {}): YardSnapshot {
  return {
    yardId: 'SANDHILLS',
    shiftId: 1,
    stateVersion: 5,
    now: T0,
    rules: DEFAULT_RULES,
    tracks: [
      { id: 'R1', name: 'R1', kind: 'receiving', capacityFt: 2000, open: true },
      { id: 'R2', name: 'R2', kind: 'receiving', capacityFt: 2000, open: true },
      { id: 'C1', name: 'C1', kind: 'classification', capacityFt: 500, open: true },
      { id: 'C2', name: 'C2', kind: 'classification', capacityFt: 500, open: true },
      { id: 'C9', name: 'C9', kind: 'classification', capacityFt: 500, open: true },
      { id: 'D1', name: 'D1', kind: 'departure', capacityFt: 2000, open: true },
      { id: 'D2', name: 'D2', kind: 'departure', capacityFt: 2000, open: true },
    ],
    blocks: [
      { id: 'A', name: 'A', destination: 'a', standingTrackId: 'C1', alternateTrackIds: ['C9'] },
      { id: 'B', name: 'B', destination: 'b', standingTrackId: 'C2', alternateTrackIds: [] },
    ],
    cars: [car('c1', 'A'), car('c2', 'A'), car('c3', 'A'), car('c4', 'B'), car('c5', 'B'), car('c6', 'B')],
    inbound: [{ id: 'I1', symbol: 'S1', scheduledArrival: T0 - 60 * MIN, eta: T0 - 60 * MIN, actualArrival: T0 - 60 * MIN, receivingTrackId: 'R1' }],
    outbound: [{ id: 'O1', symbol: 'M-1', scheduledDeparture: T0 + 240 * MIN, departure: T0 + 240 * MIN, blockSequence: ['A', 'B'], maxLengthFt: 1000, maxTons: 2000, minCars: 2, status: 'planned' }],
    locks: [],
    executions: {},
    ...over,
  }
}

let at = T0
export function resetClock() {
  at = T0
}

export function classify(key: string, cars: string[], to: string, block: string, from = 'R1'): PlanMove {
  const start = at
  const end = start + (4 + cars.length) * MIN
  at = end
  return { key, kind: 'classify', crew: 'hump', carIds: cars, fromTrackId: from, toTrackId: to, blockId: block, inboundId: 'I1', outboundId: null, plannedStart: start, plannedEnd: end }
}

export function assemble(key: string, cars: string[], from: string, to: string, block: string, train = 'O1'): PlanMove {
  const start = at
  const end = start + (6 + cars.length * 0.5) * MIN
  at = end
  return { key, kind: 'assemble', crew: 'trim', carIds: cars, fromTrackId: from, toTrackId: to, blockId: block, inboundId: null, outboundId: train, plannedStart: start, plannedEnd: end }
}

/** A valid plan over `yard()`. */
export function goodPlan(): PlanMove[] {
  resetClock()
  return [
    classify('classify:I1:A', ['c1', 'c2', 'c3'], 'C1', 'A'),
    classify('classify:I1:B', ['c4', 'c5', 'c6'], 'C2', 'B'),
    assemble('assemble:O1:A', ['c1', 'c2', 'c3'], 'C1', 'D1', 'A'),
    assemble('assemble:O1:B', ['c4', 'c5', 'c6'], 'C2', 'D1', 'B'),
  ]
}

export function moveLock(id: string, move: PlanMove): LockDef {
  return { id, kind: 'move', moveKey: move.key, beforeKey: null, carId: null, trackId: null, move, by: 'alice', reason: 'test' }
}

export function carLock(id: string, carId: string, trackId: string): LockDef {
  return { id, kind: 'car_track', moveKey: null, beforeKey: null, carId, trackId, move: null, by: 'alice', reason: 'test' }
}

export function seqLock(id: string, before: string, after: string): LockDef {
  return { id, kind: 'sequence', moveKey: before, beforeKey: after, carId: null, trackId: null, move: null, by: 'alice', reason: 'test' }
}
