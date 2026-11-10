/**
 * The analysis lane: the planner comparison and the seeded replay. Heavy and
 * optional, so they run apart from plan solves and can't delay a replan.
 * @module worker/run-analysis
 */
import { pool, withTransaction } from '../shared/db.js'
import { logger } from '../shared/logger.js'
import { initialSnapshot, smallInstance } from '../domain/scenario.js'
import type { YardSnapshot } from '../domain/types.js'
import { solve, type Algorithm } from '../planner/solve.js'
import { validatePlan } from '../validator/validate.js'
import { POLICIES, runPolicy, summarize, type ReplayOutcome } from '../replay/engine.js'
import type { ClaimedJob } from './jobs.js'

interface Row {
  instance: string
  kind: 'small' | 'full'
  algorithm: Algorithm
  timeLimitMs: number
  cost: number
  elapsedMs: number
  iterations: number
  terminatedBy: string
  provenOptimal: boolean | null
  gapPct: number | null
  valid: boolean
  moves: number
}

export interface ComparisonParams {
  smallInstances?: number
  exactLimitMs?: number
  fullSeed?: number
  fullLimits?: number[]
  iterations?: number
}

async function one(instance: string, kind: Row['kind'], snap: YardSnapshot, algorithm: Algorithm, timeLimitMs: number, iterations: number, seed: number): Promise<Row> {
  const result = await solve(snap, { algorithm, timeLimitMs, iterationLimit: iterations, seed })
  const validation = validatePlan(snap, result.moves)
  return {
    instance,
    kind,
    algorithm,
    timeLimitMs,
    cost: Math.round(result.cost.total * 100) / 100,
    elapsedMs: result.stats.elapsedMs,
    iterations: result.stats.iterations,
    terminatedBy: result.stats.terminatedBy,
    provenOptimal: result.stats.provenOptimal,
    gapPct: null,
    valid: validation.ok,
    moves: result.moves.length,
  }
}

export async function runComparison(job: ClaimedJob, onProgress?: () => void): Promise<Record<string, unknown>> {
  const params = job.params as ComparisonParams
  const smallCount = params.smallInstances ?? 6
  const exactLimit = params.exactLimitMs ?? 12_000
  const fullLimits = params.fullLimits ?? [100, 500, 2000, 5000]
  const fullSeed = params.fullSeed ?? 42
  const iterations = params.iterations ?? 200_000
  const rows: Row[] = []
  for (let i = 1; i <= smallCount; i++) {
    const snap = smallInstance(i)
    const name = `small-${i}`
    const greedy = await one(name, 'small', snap, 'greedy', exactLimit, iterations, i)
    const ls = await one(name, 'small', snap, 'local_search', 400, 4000, i)
    const exact = await one(name, 'small', snap, 'exact', exactLimit, 1500, i)
    for (const r of [greedy, ls, exact]) r.gapPct = exact.provenOptimal && exact.cost > 0 ? Math.round(((r.cost - exact.cost) / exact.cost) * 10000) / 100 : null
    rows.push(greedy, ls, exact)
    onProgress?.()
  }
  const full = initialSnapshot(fullSeed)
  rows.push(await one('full-shift', 'full', full, 'greedy', 1000, 1, fullSeed))
  for (const limit of fullLimits) {
    rows.push(await one('full-shift', 'full', full, 'local_search', limit, iterations, fullSeed))
    onProgress?.()
  }
  rows.push(await one('full-shift', 'full', full, 'exact', Math.max(...fullLimits), 500, fullSeed))
  const proven = rows.filter((r) => r.kind === 'small' && r.algorithm === 'exact' && r.provenOptimal)
  const gaps = (algorithm: Algorithm) => rows.filter((r) => r.algorithm === algorithm && r.gapPct !== null).map((r) => r.gapPct as number)
  const avg = (list: number[]) => (list.length ? Math.round((list.reduce((a, b) => a + b, 0) / list.length) * 100) / 100 : null)
  const summary = {
    smallInstances: smallCount,
    provenOptimal: proven.length,
    greedyAvgGapPct: avg(gaps('greedy')),
    greedyMaxGapPct: gaps('greedy').length ? Math.max(...gaps('greedy')) : null,
    localSearchAvgGapPct: avg(gaps('local_search')),
    localSearchMaxGapPct: gaps('local_search').length ? Math.max(...gaps('local_search')) : null,
    fullSeed,
    note: 'Exact means exact over the decoder\'s decision space (which train per group, which track per cut, in what order). On a full shift the exact search times out and returns its best so far, which is why the full-shift row has no proof.',
  }
  await withTransaction(async (client) => {
    const { rows: run } = await client.query(`INSERT INTO comparison_runs (solve_job_id, status, params, summary, finished_at) VALUES ($1, 'succeeded', $2, $3, now()) RETURNING id`, [job.id, JSON.stringify(params), JSON.stringify(summary)])
    for (const r of rows) {
      await client.query(
        `INSERT INTO comparison_rows (run_id, instance, kind, algorithm, time_limit_ms, cost, elapsed_ms, iterations, terminated_by, proven_optimal, gap_pct, valid, moves)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
        [run[0].id, r.instance, r.kind, r.algorithm, r.timeLimitMs, r.cost, r.elapsedMs, r.iterations, r.terminatedBy, r.provenOptimal, r.gapPct, r.valid, r.moves],
      )
    }
  })
  return summary
}

export interface ReplayParams {
  seeds?: number[]
  iterations?: number
}

/** Runs every policy on every seed and stores the raw rows the summary is computed from. */
export async function executeReplay(seeds: number[], iterations: number, solveJobId: string | null): Promise<{ runId: string; outcomes: ReplayOutcome[] }> {
  const outcomes: ReplayOutcome[] = []
  for (const seed of seeds) {
    for (const policy of POLICIES) {
      outcomes.push(await runPolicy(seed, policy, { iterations }))
      await new Promise((resolve) => setImmediate(resolve))
    }
  }
  const summary = summarize(outcomes)
  const runId = await withTransaction(async (client) => {
    const { rows: run } = await client.query(
      `INSERT INTO replay_runs (solve_job_id, status, params, summary, finished_at) VALUES ($1, 'succeeded', $2, $3, now()) RETURNING id`,
      [solveJobId, JSON.stringify({ seeds, iterations }), JSON.stringify({ policies: summary, perSeed: outcomes.map((o) => ({ seed: o.seed, policy: o.policy, metrics: o.metrics, digest: o.digest })) })],
    )
    const id = run[0].id as string
    for (const o of outcomes) {
      const d = o.departures
      await client.query(
        `INSERT INTO replay_departures (run_id, seed, policy, outbound_id, symbol, scheduled, actual, cars, status, on_time)
         SELECT $1, $2, $3, u.id, u.symbol, to_timestamp(u.sched / 1000.0), CASE WHEN u.act IS NULL THEN NULL ELSE to_timestamp(u.act / 1000.0) END, u.cars, u.status, u.on_time
           FROM unnest($4::text[], $5::text[], $6::float8[], $7::float8[], $8::int[], $9::text[], $10::bool[]) AS u(id, symbol, sched, act, cars, status, on_time)`,
        [id, o.seed, o.policy, d.map((x) => x.outboundId), d.map((x) => x.symbol), d.map((x) => x.scheduled), d.map((x) => x.actual), d.map((x) => x.cars), d.map((x) => x.status), d.map((x) => x.onTime)],
      )
      const c = o.cars
      await client.query(
        `INSERT INTO replay_cars (run_id, seed, policy, car_id, arrived_at, departed_at, handlings)
         SELECT $1, $2, $3, u.id, CASE WHEN u.arr IS NULL THEN NULL ELSE to_timestamp(u.arr / 1000.0) END, CASE WHEN u.dep IS NULL THEN NULL ELSE to_timestamp(u.dep / 1000.0) END, u.h
           FROM unnest($4::text[], $5::float8[], $6::float8[], $7::int[]) AS u(id, arr, dep, h)`,
        [id, o.seed, o.policy, c.map((x) => x.carId), c.map((x) => x.arrivedAt), c.map((x) => x.departedAt), c.map((x) => x.handlings)],
      )
      const e = o.events
      await client.query(
        `INSERT INTO replay_events (run_id, seed, policy, n, kind, at, code, value, detail)
         SELECT $1, $2, $3, u.n, u.kind, to_timestamp(u.at / 1000.0), u.code, u.value, u.detail
           FROM unnest($4::int[], $5::text[], $6::float8[], $7::text[], $8::float8[], $9::text[]) AS u(n, kind, at, code, value, detail)`,
        [id, o.seed, o.policy, e.map((_, i) => i + 1), e.map((x) => x.kind), e.map((x) => x.at), e.map((x) => x.code), e.map((x) => x.value), e.map((x) => x.detail)],
      )
    }
    return id
  })
  return { runId, outcomes }
}

export async function runReplayJob(job: ClaimedJob): Promise<Record<string, unknown>> {
  const params = job.params as ReplayParams
  const seeds = params.seeds?.length ? params.seeds : [42, 7, 11, 23]
  const iterations = params.iterations ?? 800
  const { runId, outcomes } = await executeReplay(seeds, iterations, job.id)
  logger.info({ runId, shifts: outcomes.length }, 'replay finished')
  return { runId, seeds, policies: POLICIES.length }
}

export async function finishAnalysisJob(job: ClaimedJob, stats: Record<string, unknown>): Promise<boolean> {
  const { rowCount } = await pool.query(
    `UPDATE solve_jobs SET status = 'succeeded', finished_at = now(), stats = $3, lease_token = NULL, lease_expires_at = NULL, error = NULL WHERE id = $1 AND lease_token = $2 AND status = 'running'`,
    [job.id, job.leaseToken, JSON.stringify(stats)],
  )
  return (rowCount ?? 0) > 0
}
