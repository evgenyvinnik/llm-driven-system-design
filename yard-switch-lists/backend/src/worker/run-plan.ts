/**
 * Runs one plan solve end to end:
 *   1. Read one consistent snapshot, and pin its state version on the job.
 *   2. Search. No side effects, so a crash here costs nothing but time.
 *   3. For a replan, also solve from scratch, ignoring the old plan, to measure
 *      what stability is worth.
 *   4. Have the independent validator check the result.
 *   5. In one transaction, fenced by the lease token: store the immutable version,
 *      finish the job, and publish if nothing needs a person.
 * @module worker/run-plan
 */
import { pool, withSnapshotRead, withTransaction } from '../shared/db.js'
import { logger } from '../shared/logger.js'
import { solvesTotal, solveSeconds, validatorRuns } from '../shared/metrics.js'
import { countDisturbed } from '../domain/diff.js'
import type { Consequence, PlanMove } from '../domain/types.js'
import { solve, type Algorithm } from '../planner/solve.js'
import { validatePlan } from '../validator/validate.js'
import { readSnapshotWith } from '../plans/snapshot.js'
import { addTrigger, raiseAlert, readYard, resolveAlert } from '../plans/state.js'
import { insertVersion, loadMoves, publishVersion } from '../plans/versions.js'
import type { ClaimedJob } from './jobs.js'

export interface PlanRunOutcome {
  versionId: string | null
  discarded: boolean
  published: boolean
  lostLease: boolean
}

/** Only a new missed departure stops for a person; rolled cars are reported, not blocking. */
function needsReview(consequences: Consequence[], conflicts: unknown[], valid: boolean): boolean {
  return !valid || conflicts.length > 0 || consequences.some((c) => c.kind === 'departure_missed' && c.reason === 'was_planned')
}

export async function runPlanJob(job: ClaimedJob, leaseLost: () => boolean): Promise<PlanRunOutcome> {
  const read = await withSnapshotRead(async (client) => {
    const yard = await readYard(client)
    const snapshot = await readSnapshotWith(client)
    const baseline: PlanMove[] | null = yard.workingVersionId ? await loadMoves(client, yard.workingVersionId) : null
    return { yard, snapshot, baseline }
  })
  const { yard, snapshot, baseline } = read
  await pool.query(`UPDATE solve_jobs SET state_version = $2, baseline_version_id = $3, snapshot = $4 WHERE id = $1`, [job.id, snapshot.stateVersion, yard.workingVersionId, JSON.stringify(snapshot)])

  const algorithm = job.algorithm as Algorithm
  const stable = job.purpose === 'replan' && baseline !== null && job.params.fromScratch !== true
  const timer = solveSeconds.startTimer({ algorithm })
  const result = await solve(snapshot, { algorithm, timeLimitMs: job.timeLimitMs, iterationLimit: job.iterationLimit, seed: job.seed, baseline, stable })
  timer()
  solvesTotal.inc({ algorithm, purpose: job.purpose, terminated_by: result.stats.terminatedBy })
  let stability: Record<string, unknown> | null = null
  if (stable && baseline) {
    const scratch = await solve(snapshot, { algorithm, timeLimitMs: Math.max(200, Math.round(job.timeLimitMs / 2)), iterationLimit: Math.round(job.iterationLimit / 2), seed: job.seed + 1, baseline: null, stable: false })
    const frozen = result.problem.frozenKeys
    stability = {
      stable: countDisturbed(baseline, result.moves, frozen),
      fromScratch: countDisturbed(baseline, scratch.moves, frozen),
      stableCost: result.cost,
      fromScratchCost: scratch.cost,
      frozenMoves: frozen.size,
      horizonMoves: result.problem.cuts.filter((c) => c.pinned).length + result.problem.pinnedTrim.length,
      frozenHorizonMin: snapshot.rules.frozenHorizonMin,
    }
  }
  const validation = validatePlan(snapshot, result.moves)
  validatorRuns.inc({ author: 'planner', result: validation.ok ? 'pass' : 'fail' })
  if (leaseLost()) {
    logger.warn({ job: job.id }, 'lease lost during solve; dropping the result')
    return { versionId: null, discarded: true, published: false, lostLease: true }
  }
  return withTransaction(async (client) => {
    const current = await readYard(client, true)
    const { rows: fence } = await client.query(`SELECT 1 FROM solve_jobs WHERE id = $1 AND lease_token = $2 AND status = 'running' FOR UPDATE`, [job.id, job.leaseToken])
    if (fence.length === 0) return { versionId: null, discarded: true, published: false, lostLease: true }
    const stats = {
      ...result.stats,
      search: undefined,
      exact: result.stats.exact,
      curve: result.stats.curve.slice(-30),
      cost: result.cost,
      moves: result.moves.length,
      violations: validation.violations.length,
      conflicts: result.conflicts.length,
    }
    if (current.shiftId !== snapshot.shiftId || current.workingVersionId !== yard.workingVersionId) {
      // A person moved the plan while this ran. Their work wins; solve again on top of it.
      await client.query(`UPDATE solve_jobs SET status = 'succeeded', finished_at = now(), stats = $2, lease_token = NULL, lease_expires_at = NULL, error = 'discarded: the working plan moved during the solve' WHERE id = $1`, [job.id, JSON.stringify({ ...stats, discarded: true })])
      await addTrigger(client, 'plan_moved_during_solve', { solveId: job.id }, current.stateVersion, current.shiftId)
      return { versionId: null, discarded: true, published: false, lostLease: false }
    }
    const reviewRequired = needsReview(result.consequences, result.conflicts, validation.ok)
    const version = await insertVersion(client, {
      shiftId: snapshot.shiftId,
      parentId: yard.workingVersionId,
      authorKind: 'planner',
      authorName: `planner (${algorithm})`,
      reason: job.reason || job.purpose,
      basedOnStateVersion: snapshot.stateVersion,
      solveId: job.id,
      objective: { ...result.cost, unassigned: result.decoded.unassigned.length },
      validation: { ok: validation.ok, violations: validation.violations, readiness: validation.readiness },
      conflicts: result.conflicts,
      consequences: result.consequences,
      stability,
      reviewRequired,
      moves: result.moves,
    })
    await client.query(`UPDATE solve_jobs SET status = 'succeeded', finished_at = now(), result_version_id = $2, stats = $3, lease_token = NULL, lease_expires_at = NULL, error = NULL WHERE id = $1`, [job.id, version.id, JSON.stringify(stats)])
    // A lock the plan can't honour is a conflict for a person, not a planner bug.
    const realViolations = validation.violations.filter((v) => v.code !== 'LOCK_VIOLATED')
    if (realViolations.length > 0) {
      await raiseAlert(client, { dedupKey: 'planner:invalid', kind: 'planner_output_invalid', severity: 'critical', message: `Planner output v${version.versionNo} failed the validator (${realViolations[0].code}): ${realViolations[0].message}. It wasn't published.` })
    } else {
      await resolveAlert(client, 'planner:invalid')
    }
    await client.query(`UPDATE alerts SET status = 'resolved', resolved_at = now() WHERE kind = 'plan_needs_review' AND status <> 'resolved'`)
    let published = false
    const fresh = current.stateVersion === snapshot.stateVersion
    if (current.autoPublish && !reviewRequired && fresh) {
      await publishVersion(client, version.id, { by: 'planner (auto)' })
      published = true
    } else if (reviewRequired) {
      const missed = result.consequences.find((c) => c.kind === 'departure_missed' && c.reason === 'was_planned')
      const summary = result.conflicts.length > 0 ? `${result.conflicts.length} lock conflict(s) to resolve` : missed ? missed.message : 'the plan failed validation'
      await raiseAlert(client, { dedupKey: `review:${version.id}`, kind: 'plan_needs_review', severity: 'warning', message: `Plan v${version.versionNo} is waiting for a yardmaster: ${summary}` })
    }
    return { versionId: version.id, discarded: false, published, lostLease: false }
  })
}
