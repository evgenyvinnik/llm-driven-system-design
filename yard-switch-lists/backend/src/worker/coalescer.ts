/**
 * Turns a burst of replan triggers into one solve. It fires once the triggers
 * have been quiet for a moment, or when the oldest has waited too long, and only
 * while no other plan solve is queued or running: a solve that starts now would
 * read newer state anyway, so whatever arrives during it simply waits for the
 * next one. Time here is the database clock.
 * @module worker/coalescer
 */
import { config } from '../shared/config.js'
import { withTransaction } from '../shared/db.js'
import { logger } from '../shared/logger.js'
import { triggersCoalesced } from '../shared/metrics.js'
import { hash32 } from '../shared/rng.js'
import { readYard } from '../plans/state.js'
import { enqueueSolve } from './jobs.js'

const LOCK_KEY = 7_203_411

export function plannerLimits(settings: { timeLimitMs?: number; iterations?: number }) {
  return {
    timeLimitMs: settings.timeLimitMs ?? config.planner.defaultTimeLimitMs,
    iterations: settings.iterations ?? config.planner.defaultIterations,
  }
}

export async function coalesceTriggers(force = false): Promise<string | null> {
  return withTransaction(async (client) => {
    const { rows: locked } = await client.query(`SELECT pg_try_advisory_xact_lock($1) AS ok`, [LOCK_KEY])
    if (!locked[0].ok) return null
    const yard = await readYard(client)
    await client.query(`UPDATE replan_triggers SET solve_id = '00000000-0000-0000-0000-000000000000' WHERE solve_id IS NULL AND shift_id <> $1`, [yard.shiftId])
    const { rows } = await client.query(
      `SELECT count(*)::int AS n,
              COALESCE(EXTRACT(EPOCH FROM now() - min(created_at)) * 1000, 0) AS oldest_ms,
              COALESCE(EXTRACT(EPOCH FROM now() - max(created_at)) * 1000, 0) AS newest_ms
         FROM replan_triggers WHERE solve_id IS NULL AND shift_id = $1`,
      [yard.shiftId],
    )
    const open = rows[0]
    if (open.n === 0) return null
    const quiet = Number(open.newest_ms) >= config.planner.coalesceQuietMs
    const overdue = Number(open.oldest_ms) >= config.planner.coalesceMaxWaitMs
    if (!force && !quiet && !overdue) return null
    const { rows: busy } = await client.query(`SELECT 1 FROM solve_jobs WHERE lane = 'plan' AND status IN ('queued', 'running') LIMIT 1`)
    if (busy.length > 0) return null
    const { rows: kinds } = await client.query(`SELECT kind, count(*)::int AS n FROM replan_triggers WHERE solve_id IS NULL AND shift_id = $1 GROUP BY kind ORDER BY kind`, [yard.shiftId])
    const reason = kinds.map((k) => (k.n > 1 ? `${k.kind} ×${k.n}` : k.kind)).join(', ')
    const limits = plannerLimits(yard.plannerSettings)
    const id = await enqueueSolve(client, {
      shiftId: yard.shiftId,
      purpose: yard.workingVersionId ? 'replan' : 'initial',
      algorithm: 'local_search',
      reason,
      timeLimitMs: limits.timeLimitMs,
      iterationLimit: limits.iterations,
      seed: hash32(`solve|${yard.seed}|${yard.stateVersion}`) % 2_000_000_000,
      triggerCount: open.n,
    })
    await client.query(`UPDATE replan_triggers SET solve_id = $1 WHERE solve_id IS NULL AND shift_id = $2`, [id, yard.shiftId])
    triggersCoalesced.observe(open.n)
    logger.info({ solve: id, triggers: open.n, reason }, 'coalesced triggers into a solve')
    return id
  })
}
