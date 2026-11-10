/**
 * Exact search for small instances: branch and bound over the same decisions
 * local search explores (train per group, then track per cut, classify order,
 * train order, departure track). Every leaf is costed by the same decoder.
 *
 * "Exact" means exact over the decoder's decision space, not over every
 * conceivable schedule: the decoder only produces list schedules that start each
 * move as early as it can. That's what the optimality gap measures: how far a
 * heuristic falls short of the best plan this planner could have produced. A
 * CP-SAT or MILP model would be the production tool for a wider guarantee.
 * @module planner/exact
 */
import { WEIGHTS } from '../domain/params.js'
import { decode, type Candidate, type Decoded } from './decode.js'
import type { Problem } from './problem.js'
import { yieldToLoop, type TerminatedBy } from './search.js'

export interface ExactStats {
  nodes: number
  leaves: number
  decodes: number
  pruned: number
  elapsedMs: number
  terminatedBy: TerminatedBy
  provenOptimal: boolean
  bestCost: number
}

function* permutations<T>(items: T[], k = items.length): Generator<T[]> {
  if (k <= 1) {
    yield items
    return
  }
  for (let i = 0; i < k; i++) {
    yield* permutations(items, k - 1)
    const j = k % 2 === 0 ? i : 0
    const t = items[j]
    items[j] = items[k - 1]
    items[k - 1] = t
  }
}

function* product(options: string[][], prefix: string[] = []): Generator<string[]> {
  if (prefix.length === options.length) {
    yield prefix
    return
  }
  for (const o of options[prefix.length]) yield* product(options, [...prefix, o])
}

export async function exactSearch(p: Problem, incumbent: Candidate, options: { timeLimitMs: number; now?: () => number }): Promise<{ best: Candidate; decoded: Decoded; stats: ExactStats }> {
  const clock = options.now ?? (() => performance.now())
  const began = clock()
  let best: Candidate = incumbent
  let bestDecoded = decode(p, incumbent)
  let bestCost = bestDecoded.cost.total
  const stats = { nodes: 0, leaves: 0, decodes: 1, pruned: 0 }
  let timedOut = false
  let lastYield = began

  const tick = async (): Promise<boolean> => {
    const t = clock()
    if (t - began >= options.timeLimitMs) {
      timedOut = true
      return false
    }
    if (t - lastYield >= 10) {
      await yieldToLoop()
      lastYield = clock()
    }
    return true
  }

  const dwellFor = (trainId: string | null, group: Problem['groups'][number]): number => {
    if (!trainId) return group.cars.length * WEIGHTS.unassignedCar
    let hours = 0
    for (const car of group.cars) hours += Math.max(0, p.trainById[trainId].departure - p.carArrival[car.id]) / 3_600_000
    return hours * WEIGHTS.dwellPerCarHour
  }
  const groups = p.groups
  const optionsPerGroup = groups.map((g) => {
    // All eligible trains, reachable or not: the decoder spills a late group, and local search can pick them too.
    return [...g.eligibleTrains, null].map((id) => ({ id, cost: dwellFor(id, g) })).sort((a, b) => a.cost - b.cost)
  })
  // Cheapest completion of groups i..n: an admissible bound, since a spill only ever costs more.
  const restMin = new Array<number>(groups.length + 1).fill(0)
  for (let i = groups.length - 1; i >= 0; i--) restMin[i] = restMin[i + 1] + Math.min(...optionsPerGroup[i].map((o) => o.cost))
  const fixedMoves = p.cuts.length + p.receives.length
  const blocksAssigned = new Set(groups.map((g) => g.blockId)).size
  const movesBound = (fixedMoves + Math.min(blocksAssigned, 1)) * WEIGHTS.move

  const freeCuts = p.cuts.filter((c) => !c.pinned)
  const trackOptions = p.cuts.filter((c) => !c.fixedTrack).map((c) => {
    const block = p.blocks[c.blockId]
    return [block.standingTrackId, ...block.alternateTrackIds].filter((id) => p.tracks[id]?.open)
  })
  const trackCuts = p.cuts.filter((c) => !c.fixedTrack)
  const departureTracks = p.snap.tracks.filter((t) => t.kind === 'departure' && t.open).map((t) => t.id)

  const groupTrain: Record<string, string | null> = {}

  const leaf = async (lowerBound: number): Promise<boolean> => {
    stats.leaves++
    for (const tracks of product(trackOptions)) {
      const altPenalty = tracks.reduce((s, id, i) => s + (id === p.blocks[trackCuts[i].blockId].standingTrackId ? 0 : WEIGHTS.alternateCut), 0)
      if (lowerBound + altPenalty >= bestCost) {
        stats.pruned++
        continue
      }
      const cutTrack: Record<string, string> = {}
      trackCuts.forEach((cut, i) => {
        cutTrack[cut.key] = tracks[i]
      })
      for (const order of permutations(freeCuts.map((c) => c.key))) {
        for (const trainOrder of permutations(p.trains.map((t) => t.id))) {
          for (const depPick of product(p.trains.map(() => departureTracks))) {
            const departureTrack: Record<string, string> = {}
            p.trains.forEach((t, i) => {
              departureTrack[t.id] = depPick[i]
            })
            const cand: Candidate = { groupTrain: { ...groupTrain }, cutTrack, classifyOrder: [...order], trainOrder: [...trainOrder], departureTrack }
            const d = decode(p, cand)
            stats.decodes++
            if (d.cost.total < bestCost - 1e-9) {
              bestCost = d.cost.total
              best = { ...cand, cutTrack: { ...cutTrack } }
              bestDecoded = d
            }
            if (stats.decodes % 64 === 0 && !(await tick())) return false
          }
        }
      }
    }
    return true
  }

  const dfs = async (i: number, cost: number): Promise<boolean> => {
    stats.nodes++
    if (stats.nodes % 64 === 0 && !(await tick())) return false
    const bound = cost + restMin[i] + movesBound
    if (bound >= bestCost) {
      stats.pruned++
      return true
    }
    if (i === groups.length) return leaf(bound)
    for (const option of optionsPerGroup[i]) {
      groupTrain[groups[i].key] = option.id
      if (!(await dfs(i + 1, cost + option.cost))) return false
    }
    delete groupTrain[groups[i].key]
    return true
  }

  await dfs(0, 0)
  return {
    best,
    decoded: bestDecoded,
    stats: {
      ...stats,
      elapsedMs: Math.round(clock() - began),
      terminatedBy: timedOut ? 'time_limit' : 'exhausted',
      provenOptimal: !timedOut,
      bestCost,
    },
  }
}
