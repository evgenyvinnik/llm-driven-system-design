/**
 * Local search: simulated annealing over decisions, with every candidate turned
 * into a real plan by the decoder. It keeps the best plan found so far, so when
 * the time limit hits it returns that, never a half-finished one. The clock only
 * truncates the search: for a fixed iteration count the result is a pure function
 * of the seed. It yields to the event loop every few milliseconds so a worker's
 * lease heartbeat keeps running during a solve.
 * @module planner/search
 */
import { hash32, makeRng, randInt } from '../shared/rng.js'
import { decode, type Candidate, type Decoded } from './decode.js'
import type { Problem } from './problem.js'

export type TerminatedBy = 'iterations' | 'time_limit' | 'no_decisions' | 'exhausted'

export interface SearchStats {
  iterations: number
  elapsedMs: number
  terminatedBy: TerminatedBy
  curve: { ms: number; iter: number; cost: number }[]
  startCost: number
  bestCost: number
}

export interface SearchOptions {
  timeLimitMs: number
  iterationLimit: number
  seed: number
  now?: () => number
}

export const yieldToLoop = () => new Promise<void>((resolve) => setImmediate(resolve))

function cloneCandidate(c: Candidate): Candidate {
  return {
    groupTrain: { ...c.groupTrain },
    cutTrack: { ...c.cutTrack },
    classifyOrder: [...c.classifyOrder],
    trainOrder: [...c.trainOrder],
    departureTrack: { ...c.departureTrack },
  }
}

function swap<T>(list: T[], i: number, j: number) {
  const t = list[i]
  list[i] = list[j]
  list[j] = t
}

/** Applies one random change and returns how to take it back. */
function perturb(p: Problem, c: Candidate, rng: () => number): (() => void) | null {
  const roll = rng()
  const cuts = c.classifyOrder
  if (roll < 0.4 && cuts.length >= 2) {
    const i = randInt(rng, 0, cuts.length - 1)
    const near = rng() < 0.7
    const j = near ? Math.min(cuts.length - 1, Math.max(0, i + randInt(rng, -4, 4))) : randInt(rng, 0, cuts.length - 1)
    if (i === j) return null
    if (rng() < 0.5) {
      swap(cuts, i, j)
      return () => swap(cuts, i, j)
    }
    const [item] = cuts.splice(i, 1)
    cuts.splice(j, 0, item)
    return () => {
      cuts.splice(j, 1)
      cuts.splice(i, 0, item)
    }
  }
  if (roll < 0.55 && c.trainOrder.length >= 2) {
    const i = randInt(rng, 0, c.trainOrder.length - 2)
    swap(c.trainOrder, i, i + 1)
    return () => swap(c.trainOrder, i, i + 1)
  }
  if (roll < 0.75) {
    const free = p.cuts.filter((x) => !x.fixedTrack)
    if (free.length === 0) return null
    const cut = free[randInt(rng, 0, free.length - 1)]
    const block = p.blocks[cut.blockId]
    if (!block) return null
    const options = [block.standingTrackId, ...block.alternateTrackIds].filter((id) => p.tracks[id]?.open)
    if (options.length < 2) return null
    const prior = c.cutTrack[cut.key]
    const next = options[randInt(rng, 0, options.length - 1)]
    if (next === prior) return null
    c.cutTrack[cut.key] = next
    return () => {
      c.cutTrack[cut.key] = prior
    }
  }
  if (roll < 0.93 && p.groups.length > 0) {
    const g = p.groups[randInt(rng, 0, p.groups.length - 1)]
    const options: (string | null)[] = [...g.eligibleTrains, null]
    if (options.length < 2) return null
    const prior = c.groupTrain[g.key] ?? null
    const next = options[randInt(rng, 0, options.length - 1)]
    if (next === prior) return null
    c.groupTrain[g.key] = next
    return () => {
      c.groupTrain[g.key] = prior
    }
  }
  const trains = p.trains
  const tracks = p.snap.tracks.filter((t) => t.kind === 'departure' && t.open)
  if (trains.length === 0 || tracks.length < 2) return null
  const t = trains[randInt(rng, 0, trains.length - 1)]
  const prior = c.departureTrack[t.id]
  const next = tracks[randInt(rng, 0, tracks.length - 1)].id
  if (next === prior) return null
  c.departureTrack[t.id] = next
  return () => {
    c.departureTrack[t.id] = prior
  }
}

export async function localSearch(p: Problem, start: Candidate, options: SearchOptions): Promise<{ best: Candidate; decoded: Decoded; stats: SearchStats }> {
  const clock = options.now ?? (() => performance.now())
  const began = clock()
  const rng = makeRng(hash32(`ls|${options.seed}`))
  const current = cloneCandidate(start)
  let currentCost = decode(p, current).cost.total
  let best = cloneCandidate(current)
  let bestDecoded = decode(p, best)
  const startCost = bestDecoded.cost.total
  let bestCost = startCost
  const curve = [{ ms: 0, iter: 0, cost: Math.round(bestCost * 10) / 10 }]
  let lastYield = began
  let iterations = 0
  let terminatedBy: TerminatedBy = 'iterations'
  const hasDecisions = p.cuts.length > 0 || p.groups.length > 0 || p.trains.length > 1
  if (!hasDecisions) terminatedBy = 'no_decisions'
  const T0 = 30
  for (; hasDecisions && iterations < options.iterationLimit; iterations++) {
    if (iterations % 8 === 0) {
      const t = clock()
      if (t - began >= options.timeLimitMs) {
        terminatedBy = 'time_limit'
        break
      }
      if (t - lastYield >= 10) {
        await yieldToLoop()
        lastYield = clock()
        if (lastYield - began >= options.timeLimitMs) {
          terminatedBy = 'time_limit'
          break
        }
      }
    }
    const undo = perturb(p, current, rng)
    if (!undo) continue
    const d = decode(p, current)
    const delta = d.cost.total - currentCost
    const temp = T0 * Math.pow(1 - iterations / options.iterationLimit, 2) + 0.01
    if (delta <= 0 || rng() < Math.exp(-delta / temp)) {
      currentCost = d.cost.total
      if (currentCost < bestCost - 1e-9) {
        bestCost = currentCost
        best = cloneCandidate(current)
        bestDecoded = d
        curve.push({ ms: Math.round(clock() - began), iter: iterations, cost: Math.round(bestCost * 10) / 10 })
      }
    } else {
      undo()
    }
  }
  return {
    best,
    decoded: bestDecoded,
    stats: { iterations, elapsedMs: Math.round(clock() - began), terminatedBy, curve, startCost, bestCost },
  }
}
