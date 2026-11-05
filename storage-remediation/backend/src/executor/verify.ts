/**
 * Post-change verification and automatic rollback.
 *
 * During the bake period each target is checked repeatedly:
 * 1. Re-read the property from ARM. If it no longer has the desired value,
 *    someone reverted it; the target fails (drift), and the scanner reopens the finding.
 * 2. Compare authorization failures since the change with the account's own
 *    baseline. A real regression triggers a rollback.
 * 3. When the bake period passes cleanly, the target is verified.
 *
 * Rollback writes the before-value recorded at intent time (never a value
 * read later), with If-Match, and is idempotent: if the account already has
 * the original value, nothing is written. Rollback is never paused by a
 * campaign pause or kill. If policy denies the rollback (a deny assignment is
 * already in force), the target fails loudly so a human can add an exemption.
 * @module executor/verify
 */
import { isDeepStrictEqual } from 'node:util'
import { evaluateBakeSignal, type BakeThresholds } from '../domain/bake.js'
import { getControl, type Control } from '../domain/controls.js'
import { rollbacks, targetTransitions } from '../shared/metrics.js'
import { summarizeWindow, type ExecutorDeps } from './apply.js'
import type { TargetRow } from './types.js'

export type BakeOutcome = 'baking' | 'verified' | 'rolled_back' | 'rollback_pending' | 'rollback_failed' | 'drifted' | 'lost_lease'

export interface VerifyDeps extends ExecutorDeps {
  thresholds: BakeThresholds
}

export async function rollbackTarget(deps: VerifyDeps, t: TargetRow, control: Control): Promise<BakeOutcome> {
  const actor = `service:${deps.instanceId}`
  for (let attempt = 0; attempt < 4; attempt++) {
    // Rollback has priority over new work: wait for a token inline instead of deferring.
    let wait = await deps.buckets.take(t.subscriptionId)
    while (wait > 0) {
      await deps.sleep(Math.min(wait, 5000))
      wait = await deps.buckets.take(t.subscriptionId)
    }
    const current = await deps.arm.get(t.accountId, control.kind).catch(() => null)
    if (!current) continue
    if (current.status === 429 || current.status === 503) {
      await deps.sleep(current.retryAfterMs ?? 1000)
      continue
    }
    if (current.status !== 200) break
    const value = control.read(current.body.properties as never)
    if (isDeepStrictEqual(value, t.beforeValue)) {
      const ok = await deps.store.markRolledBack(t, { restoredValue: value, etagAfter: current.etag ?? null, outcome: 'already_restored' }, actor, control.id)
      return ok ? 'rolled_back' : 'lost_lease'
    }
    const res = await deps.arm.write(t.accountId, control.kind, control.restore(t.beforeValue), current.etag, `${t.operationId ?? `rem-${t.id}`}-rollback-${attempt}`).catch(() => null)
    if (!res) continue // no response: the next round re-reads and sees whether it landed
    if (res.status === 200) {
      const ok = await deps.store.markRolledBack(t, { restoredValue: control.read(res.body.properties as never), etagAfter: res.etag ?? null, outcome: 'written' }, actor, control.id)
      if (!ok) return 'lost_lease'
      rollbacks.inc({ control: control.id, outcome: 'restored' })
      targetTransitions.inc({ to: 'rolled_back' })
      await deps.events(t.campaignId, { type: 'target.rolled_back', accountId: t.accountId, waveNo: t.waveNo, message: t.rollbackReason ?? 'rolled back' })
      return 'rolled_back'
    }
    if (res.status === 403) {
      rollbacks.inc({ control: control.id, outcome: 'denied' })
      await deps.store.finish(t, 'failed', `ROLLBACK DENIED: ${res.body.error?.message ?? 'forbidden'}. Add a policy exemption and restore manually.`, actor, control.id)
      await deps.events(t.campaignId, { type: 'target.rollback_failed', accountId: t.accountId, waveNo: t.waveNo, message: res.body.error?.message })
      return 'rollback_failed'
    }
    if (res.status === 429) {
      await deps.buckets.penalize(t.subscriptionId, res.retryAfterMs ?? 1000)
      await deps.sleep(res.retryAfterMs ?? 1000)
    }
    // 412 or 5xx: loop re-reads; a 5xx that was applied shows up as already restored.
  }
  // Bounded: after three failed rounds a human takes over (the account is still in the remediated state).
  if (t.attempts + 1 >= 3) {
    rollbacks.inc({ control: control.id, outcome: 'gave_up' })
    await deps.store.finish(t, 'failed', `ROLLBACK FAILED after ${t.attempts + 1} rounds; restore ${JSON.stringify(t.beforeValue)} manually`, actor, control.id)
    await deps.events(t.campaignId, { type: 'target.rollback_failed', accountId: t.accountId, waveNo: t.waveNo })
    return 'rollback_failed'
  }
  await deps.store.releaseBaking(t, true)
  return 'rollback_pending'
}

export async function checkBakingTarget(deps: VerifyDeps, t: TargetRow, controlId: string): Promise<BakeOutcome> {
  const control = getControl(controlId)
  const actor = `service:${deps.instanceId}`
  if (t.state === 'rolling_back') return rollbackTarget(deps, t, control)

  const current = await deps.arm.get(t.accountId, control.kind).catch(() => null)
  if (!current || current.status === 429 || current.status === 503) {
    await deps.store.releaseBaking(t)
    return 'baking'
  }
  if (current.status === 200 && !control.isCompliant(control.read(current.body.properties as never))) {
    const ok = await deps.store.finish(t, 'failed', 'Reverted outside the campaign during the bake period (drift)', actor, control.id)
    if (ok) await deps.events(t.campaignId, { type: 'target.drifted', accountId: t.accountId, waveNo: t.waveNo })
    return ok ? 'drifted' : 'lost_lease'
  }

  const now = deps.clock()
  const appliedAt = t.appliedAt?.getTime() ?? now
  let points
  try {
    points = await deps.arm.transactions(t.accountId, appliedAt, now)
  } catch {
    await deps.store.releaseBaking(t)
    return 'baking'
  }
  const decision = evaluateBakeSignal(t.baseline ?? { requests: 0, authErrors: 0, minutes: 1 }, summarizeWindow(points, appliedAt, now + 1), deps.thresholds)
  if (decision.rollback) {
    const ok = await deps.store.startRollback(t, decision.reason, actor, control.id)
    if (!ok) return 'lost_lease'
    targetTransitions.inc({ to: 'rolling_back' })
    await deps.events(t.campaignId, { type: 'target.rollback_started', accountId: t.accountId, waveNo: t.waveNo, message: decision.reason })
    t.state = 'rolling_back'
    t.rollbackReason = decision.reason
    return rollbackTarget(deps, t, control)
  }
  if (t.bakeUntil && now >= t.bakeUntil.getTime()) {
    const ok = await deps.store.markVerified(t, actor, control.id)
    if (!ok) return 'lost_lease'
    targetTransitions.inc({ to: 'verified' })
    await deps.events(t.campaignId, { type: 'target.verified', accountId: t.accountId, waveNo: t.waveNo })
    return 'verified'
  }
  await deps.store.releaseBaking(t)
  return 'baking'
}
