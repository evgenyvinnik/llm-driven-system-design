/**
 * The seeded yard: a fixed layout and a shift's trains and cars generated from
 * a seed. Pure, so the database seed, the live simulator, the replay engine and
 * the tests all see the same world for the same seed.
 *
 * The yard, its train symbols and its schedule are invented for this project;
 * no figure here comes from BNSF or any railroad.
 * @module domain/scenario
 */
import { hash32, makeRng, randInt } from '../shared/rng.js'
import { DEFAULT_RULES, MIN } from './params.js'
import type { BlockDef, CarState, InboundDef, OutboundDef, TrackDef, YardSnapshot } from './types.js'

export const YARD_ID = 'SANDHILLS'
const HOUR = 60 * MIN

export const TRACKS: TrackDef[] = [
  { id: 'R1', name: 'Receiving 1', kind: 'receiving', capacityFt: 4200, open: true },
  { id: 'R2', name: 'Receiving 2', kind: 'receiving', capacityFt: 4200, open: true },
  { id: 'R3', name: 'Receiving 3', kind: 'receiving', capacityFt: 3600, open: true },
  ...[1800, 1500, 1800, 1500, 1500, 1200, 1500, 1200].map((capacityFt, i): TrackDef => ({
    id: `C${i + 1}`,
    name: `Class ${i + 1}`,
    kind: 'classification',
    capacityFt,
    open: true,
  })),
  { id: 'C9', name: 'Swing 9', kind: 'classification', capacityFt: 1500, open: true },
  { id: 'C10', name: 'Swing 10', kind: 'classification', capacityFt: 1500, open: true },
  { id: 'D1', name: 'Departure 1', kind: 'departure', capacityFt: 6000, open: true },
  { id: 'D2', name: 'Departure 2', kind: 'departure', capacityFt: 6000, open: true },
  { id: 'D3', name: 'Departure 3', kind: 'departure', capacityFt: 5200, open: true },
]

export const BLOCKS: BlockDef[] = [
  { id: 'KCK', name: 'KCK', destination: 'Kansas City', standingTrackId: 'C1', alternateTrackIds: ['C9'] },
  { id: 'GAL', name: 'GAL', destination: 'Galesburg', standingTrackId: 'C2', alternateTrackIds: ['C10'] },
  { id: 'DEN', name: 'DEN', destination: 'Denver', standingTrackId: 'C3', alternateTrackIds: ['C9'] },
  { id: 'BAR', name: 'BAR', destination: 'Barstow', standingTrackId: 'C4', alternateTrackIds: ['C10'] },
  { id: 'TPL', name: 'TPL', destination: 'Temple', standingTrackId: 'C5', alternateTrackIds: ['C9'] },
  { id: 'MEM', name: 'MEM', destination: 'Memphis', standingTrackId: 'C6', alternateTrackIds: ['C10'] },
  { id: 'CHI', name: 'CHI', destination: 'Chicago', standingTrackId: 'C7', alternateTrackIds: ['C9'] },
  { id: 'PDX', name: 'PDX', destination: 'Portland', standingTrackId: 'C8', alternateTrackIds: ['C10'] },
]

const OUTBOUND_TEMPLATE: { symbol: string; offsetH: number; blocks: string[]; minCars: number }[] = [
  { symbol: 'M-GALKCK', offsetH: 4, blocks: ['GAL', 'KCK'], minCars: 10 },
  { symbol: 'M-DENBAR', offsetH: 5.5, blocks: ['DEN', 'BAR'], minCars: 18 },
  { symbol: 'M-CHIGAL', offsetH: 7, blocks: ['CHI', 'GAL'], minCars: 18 },
  { symbol: 'M-MEMTPL', offsetH: 8.5, blocks: ['MEM', 'TPL'], minCars: 18 },
  { symbol: 'M-KCKCHI', offsetH: 10, blocks: ['KCK', 'CHI', 'MEM'], minCars: 18 },
  { symbol: 'M-BARPDX', offsetH: 11, blocks: ['BAR', 'PDX', 'DEN'], minCars: 18 },
  { symbol: 'M-TPLPDX', offsetH: 11.5, blocks: ['TPL', 'PDX'], minCars: 12 },
]

const INBOUND_OFFSETS_H = [-0.75, 0.75, 2, 3.25, 5, 6.5]
const HAZMAT_CLASSES = ['3', '2.1', '8', '1.1']

export interface ShiftScenario {
  seed: number
  shiftIndex: number
  shiftStart: number
  inbound: InboundDef[]
  outbound: OutboundDef[]
  cars: CarState[]
}

export const SHIFT_EPOCH = Date.UTC(2026, 10, 9, 6, 0, 0)
export const SHIFT_HOURS = 12

export function shiftStart(shiftIndex: number): number {
  return SHIFT_EPOCH + (shiftIndex - 1) * SHIFT_HOURS * HOUR
}

/** One shift's inbound and outbound trains, with cars, from (seed, shiftIndex). */
export function generateShift(seed: number, shiftIndex: number): ShiftScenario {
  const start = shiftStart(shiftIndex)
  const rng = makeRng(hash32(`shift|${seed}|${shiftIndex}`))
  const tag = String.fromCharCode(64 + ((shiftIndex - 1) % 26) + 1)
  const inbound: InboundDef[] = []
  const cars: CarState[] = []
  INBOUND_OFFSETS_H.forEach((offset, i) => {
    const id = `I${shiftIndex}${i + 1}`
    const scheduled = start + Math.round((offset + (rng() - 0.5) * 0.4) * HOUR)
    const symbol = `${tag}${4400 + randInt(rng, 10, 99) + i * 100}`
    inbound.push({ id, symbol, scheduledArrival: scheduled, eta: scheduled, actualArrival: null, receivingTrackId: null })
    const count = randInt(rng, 22, 34)
    // Each inbound train leans towards a few blocks, as real trains do.
    const weights = BLOCKS.map(() => 0.3 + rng() * rng() * 3)
    const sum = weights.reduce((a, b) => a + b, 0)
    for (let c = 0; c < count; c++) {
      let pick = rng() * sum
      let b = 0
      while (b < BLOCKS.length - 1 && pick > weights[b]) {
        pick -= weights[b]
        b++
      }
      const hazmat = rng() < 0.07 ? HAZMAT_CLASSES[randInt(rng, 0, HAZMAT_CLASSES.length - 1)] : null
      const lengthFt = [50, 55, 60, 60, 65, 70, 75, 89][randInt(rng, 0, 7)]
      cars.push({
        id: `${id}-${String(c + 1).padStart(2, '0')}`,
        lengthFt,
        tons: randInt(rng, 40, 130),
        blockId: BLOCKS[b].id,
        hazmatClass: hazmat,
        inboundId: id,
        consistPos: c + 1,
        position: 'inbound',
        trackId: null,
        held: false,
        coupledTo: null,
        coupledSeq: null,
        arrivedAt: null,
      })
    }
  })
  const outbound: OutboundDef[] = OUTBOUND_TEMPLATE.map((t, i) => {
    const dep = start + Math.round(t.offsetH * HOUR)
    return {
      id: `O${shiftIndex}${i + 1}`,
      symbol: t.symbol,
      scheduledDeparture: dep,
      departure: dep,
      blockSequence: t.blocks,
      maxLengthFt: 3000,
      maxTons: 7000,
      minCars: t.minCars,
      status: 'planned',
    }
  })
  return { seed, shiftIndex, shiftStart: start, inbound, outbound, cars }
}

/** A complete in-memory yard state for a fresh shift (used by replay and tests). */
export function initialSnapshot(seed: number, shiftIndex = 1): YardSnapshot {
  const s = generateShift(seed, shiftIndex)
  return {
    yardId: YARD_ID,
    shiftId: shiftIndex,
    stateVersion: 1,
    now: s.shiftStart,
    tracks: TRACKS.map((t) => ({ ...t })),
    blocks: BLOCKS.map((b) => ({ ...b, alternateTrackIds: [...b.alternateTrackIds] })),
    cars: s.cars,
    inbound: s.inbound,
    outbound: s.outbound,
    locks: [],
    executions: {},
    rules: DEFAULT_RULES,
  }
}

/** A small instance for the exact search: few cuts, few tracks, tight enough to be interesting. */
export function smallInstance(seed: number): YardSnapshot {
  const rng = makeRng(hash32(`small|${seed}`))
  const now = SHIFT_EPOCH
  const blockIds = ['KCK', 'GAL', 'DEN']
  const blocks: BlockDef[] = [
    { id: 'KCK', name: 'KCK', destination: 'Kansas City', standingTrackId: 'C1', alternateTrackIds: ['C9'] },
    { id: 'GAL', name: 'GAL', destination: 'Galesburg', standingTrackId: 'C2', alternateTrackIds: ['C9'] },
    { id: 'DEN', name: 'DEN', destination: 'Denver', standingTrackId: 'C3', alternateTrackIds: [] },
  ]
  const tracks: TrackDef[] = [
    { id: 'R1', name: 'Receiving 1', kind: 'receiving', capacityFt: 3000, open: true },
    { id: 'C1', name: 'Class 1', kind: 'classification', capacityFt: 120 + randInt(rng, 0, 2) * 60, open: true },
    { id: 'C2', name: 'Class 2', kind: 'classification', capacityFt: 120 + randInt(rng, 0, 2) * 60, open: true },
    { id: 'C3', name: 'Class 3', kind: 'classification', capacityFt: 180 + randInt(rng, 0, 2) * 60, open: true },
    { id: 'C9', name: 'Swing 9', kind: 'classification', capacityFt: 240, open: true },
    { id: 'D1', name: 'Departure 1', kind: 'departure', capacityFt: 3000, open: true },
    { id: 'D2', name: 'Departure 2', kind: 'departure', capacityFt: 3000, open: true },
  ]
  const inbound: InboundDef[] = []
  const cars: CarState[] = []
  const trainCount = 2
  for (let t = 0; t < trainCount; t++) {
    const id = `IS${t + 1}`
    const eta = now + Math.round((0.1 + t * 0.5 + rng() * 0.4) * HOUR)
    inbound.push({ id, symbol: `S${100 + t}`, scheduledArrival: eta, eta, actualArrival: null, receivingTrackId: null })
    // At most two blocks per train, so the exact search stays small enough to finish.
    const first = randInt(rng, 0, 2)
    const used = [blockIds[first], blockIds[(first + 1 + randInt(rng, 0, 1)) % 3]]
    let pos = 1
    for (const blockId of used) {
      const n = randInt(rng, 2, 5)
      for (let c = 0; c < n; c++) {
        const carId = `${id}-${String(pos).padStart(2, '0')}`
        cars.push({
          id: carId,
          lengthFt: [50, 60, 70][randInt(rng, 0, 2)],
          tons: randInt(rng, 40, 120),
          blockId,
          hazmatClass: null,
          inboundId: id,
          consistPos: pos,
          position: 'inbound',
          trackId: null,
          held: false,
          coupledTo: null,
          coupledSeq: null,
          arrivedAt: null,
        })
        pos++
      }
    }
  }
  // Tight on purpose: the first train can't take everything, so the order of work matters.
  const dep1 = now + Math.round((1.5 + rng() * 0.6) * HOUR)
  const dep2 = now + Math.round((2.6 + rng() * 1) * HOUR)
  const outbound: OutboundDef[] = [
    { id: 'OS1', symbol: 'S-KCKGAL', scheduledDeparture: dep1, departure: dep1, blockSequence: ['KCK', 'GAL'], maxLengthFt: 600, maxTons: 1000, minCars: 2, status: 'planned' },
    { id: 'OS2', symbol: 'S-DENKCK', scheduledDeparture: dep2, departure: dep2, blockSequence: ['DEN', 'KCK', 'GAL'], maxLengthFt: 900, maxTons: 2000, minCars: 2, status: 'planned' },
  ]
  return { yardId: YARD_ID, shiftId: 1, stateVersion: 1, now, tracks, blocks, cars, inbound, outbound, locks: [], executions: {}, rules: DEFAULT_RULES }
}
