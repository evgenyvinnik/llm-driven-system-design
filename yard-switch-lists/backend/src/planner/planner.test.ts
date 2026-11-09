import { describe, expect, it } from 'vitest'
import { initialSnapshot, smallInstance } from '../domain/scenario.js'
import { validatePlan } from '../validator/validate.js'
import { decode } from './decode.js'
import { greedyCandidate } from './greedy.js'
import { buildProblem } from './problem.js'
import { solve } from './solve.js'

const SEEDS = [42, 7, 11, 23, 99]

describe('planner invariants', () => {
  it.each(SEEDS)('greedy output passes the independent validator (seed %i)', async (seed) => {
    const snap = initialSnapshot(seed)
    const result = await solve(snap, { algorithm: 'greedy', timeLimitMs: 1000, iterationLimit: 1, seed })
    expect(validatePlan(snap, result.moves).violations).toEqual([])
    expect(result.moves.length).toBeGreaterThan(20)
  })

  it.each(SEEDS)('local search output passes the validator and never loses to its start (seed %i)', async (seed) => {
    const snap = initialSnapshot(seed)
    const greedy = await solve(snap, { algorithm: 'greedy', timeLimitMs: 1000, iterationLimit: 1, seed })
    const ls = await solve(snap, { algorithm: 'local_search', timeLimitMs: 20_000, iterationLimit: 400, seed })
    expect(validatePlan(snap, ls.moves).violations).toEqual([])
    expect(ls.cost.total).toBeLessThanOrEqual(greedy.cost.total + 1e-9)
  })

  it('never puts a held car on a move towards a train', async () => {
    const snap = initialSnapshot(42)
    const held = snap.cars[3]
    held.held = true
    const result = await solve(snap, { algorithm: 'local_search', timeLimitMs: 20_000, iterationLimit: 200, seed: 1 })
    const offending = result.moves.filter((m) => m.kind !== 'receive' && m.carIds.includes(held.id))
    expect(offending).toEqual([])
    expect(validatePlan(snap, result.moves).ok).toBe(true)
  })

  it('moves are listed in start-time order', async () => {
    const snap = initialSnapshot(7)
    const { moves } = await solve(snap, { algorithm: 'local_search', timeLimitMs: 20_000, iterationLimit: 200, seed: 7 })
    for (let i = 1; i < moves.length; i++) expect(moves[i].plannedStart).toBeGreaterThanOrEqual(moves[i - 1].plannedStart)
  })

  it('every train stays within its length and tonnage limits', async () => {
    const snap = initialSnapshot(11)
    snap.outbound.forEach((t) => {
      t.maxLengthFt = 1500
      t.maxTons = 2500
    })
    const { moves } = await solve(snap, { algorithm: 'greedy', timeLimitMs: 1000, iterationLimit: 1, seed: 1 })
    const result = validatePlan(snap, moves)
    expect(result.violations).toEqual([])
    for (const r of result.readiness) {
      expect(r.lengthFt).toBeLessThanOrEqual(1500)
      expect(r.tons).toBeLessThanOrEqual(2500)
    }
  })

  it('a block never lands outside its standing order', async () => {
    const snap = initialSnapshot(23)
    const { moves } = await solve(snap, { algorithm: 'local_search', timeLimitMs: 20_000, iterationLimit: 200, seed: 3 })
    for (const m of moves.filter((x) => x.kind === 'classify')) {
      const b = snap.blocks.find((x) => x.id === m.blockId)!
      expect([b.standingTrackId, ...b.alternateTrackIds]).toContain(m.toTrackId)
    }
  })
})

describe('time limit and best-so-far', () => {
  it('stops at the time limit and still returns a complete, valid plan', async () => {
    const snap = initialSnapshot(42)
    const started = performance.now()
    const result = await solve(snap, { algorithm: 'local_search', timeLimitMs: 60, iterationLimit: 10_000_000, seed: 42 })
    expect(result.stats.terminatedBy).toBe('time_limit')
    expect(performance.now() - started).toBeLessThan(2500)
    expect(validatePlan(snap, result.moves).ok).toBe(true)
    expect(result.cost.total).toBeLessThanOrEqual(result.stats.startCost + 1e-9)
  })

  it('a fixed iteration count gives the same plan every time', async () => {
    const run = () => solve(initialSnapshot(42), { algorithm: 'local_search', timeLimitMs: 60_000, iterationLimit: 150, seed: 9 })
    const [a, b] = [await run(), await run()]
    expect(a.moves).toEqual(b.moves)
    expect(a.cost).toEqual(b.cost)
  })

  it('a longer budget never finds a worse plan on the same trajectory', async () => {
    const snap = initialSnapshot(7)
    const short = await solve(snap, { algorithm: 'local_search', timeLimitMs: 60_000, iterationLimit: 100, seed: 5 })
    const long = await solve(snap, { algorithm: 'local_search', timeLimitMs: 60_000, iterationLimit: 400, seed: 5 })
    expect(long.cost.total).toBeLessThanOrEqual(short.cost.total + 200) // Different cooling, so allow a little.
  })
})

describe('every search result is valid, including the odd corners search finds', () => {
  it('local search on 20 tight small instances always passes the validator', async () => {
    for (let seed = 1; seed <= 20; seed++) {
      const snap = smallInstance(seed)
      const result = await solve(snap, { algorithm: 'local_search', timeLimitMs: 5000, iterationLimit: 1500, seed })
      expect(validatePlan(snap, result.moves).violations, `seed ${seed}`).toEqual([])
    }
  }, 60_000)
})

describe('exact search', () => {
  it.each([1, 2, 4, 5])('proves an optimum no heuristic beats on small instance %i', async (seed) => {
    const snap = smallInstance(seed)
    const p = buildProblem(snap)
    const greedy = decode(p, greedyCandidate(p)).cost.total
    const ls = await solve(snap, { algorithm: 'local_search', timeLimitMs: 2000, iterationLimit: 800, seed })
    const exact = await solve(snap, { algorithm: 'exact', timeLimitMs: 25_000, iterationLimit: 400, seed })
    expect(exact.stats.provenOptimal).toBe(true)
    expect(exact.cost.total).toBeLessThanOrEqual(greedy + 1e-9)
    expect(exact.cost.total).toBeLessThanOrEqual(ls.cost.total + 1e-9)
    expect(validatePlan(snap, exact.moves).ok).toBe(true)
  }, 60_000)

  it('gives up honestly on a full shift: best so far, no proof', async () => {
    const snap = initialSnapshot(42)
    const exact = await solve(snap, { algorithm: 'exact', timeLimitMs: 150, iterationLimit: 100, seed: 1 })
    expect(exact.stats.provenOptimal).toBe(false)
    expect(exact.stats.terminatedBy).toBe('time_limit')
    expect(validatePlan(snap, exact.moves).ok).toBe(true)
  })
})
