/**
 * One solve from a snapshot to a plan: greedy, local search or exact, optionally
 * stable against a previous plan. Pure apart from the clock.
 * @module planner/solve
 */
import type { Consequence, CostBreakdown, LockConflict, MoveDiffCounts, PlanMove, YardSnapshot } from '../domain/types.js'
import { decode, type Decoded } from './decode.js'
import { exactSearch, type ExactStats } from './exact.js'
import { baselineCandidate, greedyCandidate } from './greedy.js'
import { deriveConsequences, verifyLocks } from './outcome.js'
import { buildProblem, type Problem } from './problem.js'
import { localSearch, type SearchStats } from './search.js'

export type Algorithm = 'greedy' | 'local_search' | 'exact'

export interface SolveOptions {
  algorithm: Algorithm
  timeLimitMs: number
  iterationLimit: number
  seed: number
  baseline?: PlanMove[] | null
  stable?: boolean
  now?: () => number
}

export interface SolveResult {
  algorithm: Algorithm
  moves: PlanMove[]
  cost: CostBreakdown
  decoded: Decoded
  conflicts: LockConflict[]
  consequences: Consequence[]
  changes: MoveDiffCounts | null
  problem: Problem
  stats: {
    elapsedMs: number
    iterations: number
    terminatedBy: string
    curve: { ms: number; iter: number; cost: number }[]
    startCost: number
    bestCost: number
    provenOptimal: boolean | null
    exact: ExactStats | null
    search: SearchStats | null
  }
}

export async function solve(snapshot: YardSnapshot, options: SolveOptions): Promise<SolveResult> {
  const clock = options.now ?? (() => performance.now())
  const began = clock()
  const problem = buildProblem(snapshot, { baseline: options.baseline ?? null, stable: options.stable })
  const greedy = greedyCandidate(problem)
  const start = problem.stable ? baselineCandidate(problem, greedy) : greedy
  let decoded = decode(problem, start)
  let search: SearchStats | null = null
  let exact: ExactStats | null = null
  const startCost = decoded.cost.total
  if (options.algorithm === 'local_search') {
    const result = await localSearch(problem, start, { timeLimitMs: options.timeLimitMs, iterationLimit: options.iterationLimit, seed: options.seed, now: clock })
    decoded = result.decoded
    search = result.stats
  } else if (options.algorithm === 'exact') {
    const seeded = await localSearch(problem, start, { timeLimitMs: Math.min(250, options.timeLimitMs / 4), iterationLimit: Math.min(1500, options.iterationLimit), seed: options.seed, now: clock })
    const result = await exactSearch(problem, seeded.best, { timeLimitMs: options.timeLimitMs, now: clock })
    decoded = result.decoded
    exact = result.stats
  }
  return {
    algorithm: options.algorithm,
    moves: decoded.allMoves,
    cost: decoded.cost,
    decoded,
    conflicts: verifyLocks(problem, decoded),
    consequences: deriveConsequences(problem, decoded),
    changes: decoded.changes,
    problem,
    stats: {
      elapsedMs: Math.round(clock() - began),
      iterations: search?.iterations ?? exact?.decodes ?? 0,
      terminatedBy: search?.terminatedBy ?? exact?.terminatedBy ?? 'constructed',
      curve: search?.curve ?? [{ ms: 0, iter: 0, cost: Math.round(startCost * 10) / 10 }],
      startCost,
      bestCost: decoded.cost.total,
      provenOptimal: exact ? exact.provenOptimal : null,
      exact,
      search,
    },
  }
}
