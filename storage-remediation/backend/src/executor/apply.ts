/**
 * Applying one campaign target: the idempotent desired-state write.
 *
 * Order of operations, and why:
 * 1. Claim with a lease and a fence. Duplicate queue messages, a second
 *    executor, or a stale worker after its lease expired all fail here.
 * 2. Check the campaign (paused → release, killed → cancel) and exceptions
 *    granted after planning.
 * 3. Take a per-subscription write token (and honor any 429 block).
 * 4. Re-read the resource from ARM; never trust the scan snapshot. Revalidate
 *    the plan (ring, evidence) and decide: write, skip, escalate, or record a
 *    write an earlier attempt already made (domain/revalidate.ts).
 * 5. Record intent durably BEFORE writing: before-value, etag, auth-failure
 *    baseline, and an operation ID sent as x-ms-client-request-id.
 * 6. Write with If-Match. 412 → re-read and decide again; 429 → block the
 *    subscription and defer with growing back-off (bounded); 5xx or timeout →
 *    the outcome is unknown, so reconcile against actual state before any
 *    retry, then retry with back-off (bounded) or give up.
 * @module executor/apply
 */
import type { ArmResult, ControlPlane, TransactionPoint } from '../arm/control-plane.js'
import type { MetricWindow } from '../domain/bake.js'
import { getControl, type Control } from '../domain/controls.js'
import { decideAfterRead, errorBackoffMs, revalidatePlan, throttleBackoffMs } from '../domain/revalidate.js'
import { ringOf } from '../domain/types.js'
import { applyDuration, targetTransitions, tokenWaitSeconds } from '../shared/metrics.js'
import type { BucketStore } from './buckets.js'
import type { CampaignEvent, DeferKind, FinishState, TargetRow, TargetStore, WriteOutcome } from './types.js'

export interface ExecutorDeps {
  store: TargetStore
  arm: ControlPlane
  buckets: BucketStore
  events: (campaignId: string, event: CampaignEvent) => Promise<void>
  clock: () => number
  sleep: (ms: number) => Promise<void>
  instanceId: string
  leaseMs: number
  /** Bound on server errors and timeouts per target. */
  maxAttempts: number
  /** Bound on 429s per target; past it the target fails and counts against the wave budget. */
  maxThrottles: number
  /** Longest token wait we sleep through inline; longer waits defer the target. */
  maxInlineWaitMs: number
  baselineWindowMs: number
  /** 0..1, for back-off jitter; injectable for deterministic tests. */
  random?: () => number
  /** Test hook, called after a successful write and before it is recorded. */
  afterWrite?: (t: TargetRow) => void
}

export type ProcessOutcome = 'not_claimed' | 'paused' | 'cancelled' | 'skipped' | 'escalated' | 'deferred' | 'applied' | 'recovered' | 'failed' | 'lost_lease'

const MAX_CONFLICTS = 3

export function summarizeWindow(points: TransactionPoint[], from: number, to: number): MetricWindow {
  let requests = 0
  let authErrors = 0
  for (const p of points) {
    if (p.at < from || p.at >= to) continue
    requests += p.success + p.authErrors
    authErrors += p.authErrors
  }
  return { requests, authErrors, minutes: Math.max(0, to - from) / 60_000 }
}

/** Deterministic per attempt: the same target, claim and attempt always produce the same ID. */
export function operationIdFor(t: TargetRow): string {
  return `rem-${t.campaignId}-${t.id}-f${t.fence}-a${t.attempts}`
}

async function acquireToken(deps: ExecutorDeps, subscriptionId: string): Promise<number> {
  const started = deps.clock()
  for (;;) {
    const wait = await deps.buckets.take(subscriptionId)
    if (wait === 0) {
      tokenWaitSeconds.observe((deps.clock() - started) / 1000)
      return 0
    }
    if (wait > deps.maxInlineWaitMs || deps.clock() - started + wait > deps.maxInlineWaitMs * 2) return wait
    await deps.sleep(wait)
  }
}

async function measureBaseline(deps: ExecutorDeps, accountId: string): Promise<MetricWindow> {
  const now = deps.clock()
  try {
    return summarizeWindow(await deps.arm.transactions(accountId, now - deps.baselineWindowMs, now), now - deps.baselineWindowMs, now)
  } catch {
    return { requests: 0, authErrors: 0, minutes: deps.baselineWindowMs / 60_000 }
  }
}

/** A thrown call (timeout, connection reset) becomes status 0: the outcome is unknown. */
async function attempt(call: () => Promise<ArmResult>): Promise<ArmResult> {
  try {
    return await call()
  } catch (err) {
    return { status: 0, body: { id: '', name: '', properties: {}, error: { code: 'NoResponse', message: err instanceof Error ? err.message : String(err) } } }
  }
}

function transition(to: string) {
  targetTransitions.inc({ to })
}

async function applied(deps: ExecutorDeps, t: TargetRow, control: Control, value: unknown, etag: string | null, outcome: WriteOutcome, bakeSeconds: number): Promise<ProcessOutcome> {
  const ok = await deps.store.markApplied(t, { afterValue: value, etagAfter: etag, outcome, bakeUntil: new Date(deps.clock() + bakeSeconds * 1000) }, `service:${deps.instanceId}`, control.id)
  if (!ok) return 'lost_lease'
  transition('baking')
  await deps.events(t.campaignId, { type: 'target.applied', accountId: t.accountId, waveNo: t.waveNo, outcome, operationId: t.operationId })
  return outcome === 'recovered' ? 'recovered' : 'applied'
}

async function finish(deps: ExecutorDeps, t: TargetRow, control: Control, state: FinishState, reason: string): Promise<ProcessOutcome> {
  const ok = await deps.store.finish(t, state, reason, `service:${deps.instanceId}`, control.id)
  if (!ok) return 'lost_lease'
  transition(state)
  await deps.events(t.campaignId, { type: `target.${state}`, accountId: t.accountId, waveNo: t.waveNo, message: reason })
  return state
}

async function defer(deps: ExecutorDeps, t: TargetRow, ms: number, reason: string, kind: DeferKind): Promise<ProcessOutcome> {
  const ok = await deps.store.defer(t, new Date(deps.clock() + ms), reason, kind)
  if (!ok) return 'lost_lease'
  transition('queued')
  await deps.events(t.campaignId, { type: kind === 'throttle' ? 'target.throttled' : 'target.deferred', accountId: t.accountId, waveNo: t.waveNo, message: reason, retryInMs: ms })
  return 'deferred'
}

async function throttled(deps: ExecutorDeps, t: TargetRow, control: Control, retryAfterMs: number, what: string): Promise<ProcessOutcome> {
  await deps.buckets.penalize(t.subscriptionId, retryAfterMs)
  if (t.throttleCount + 1 > deps.maxThrottles) return finish(deps, t, control, 'failed', `Gave up after ${t.throttleCount + 1} throttled attempts (${what})`)
  const ms = throttleBackoffMs(retryAfterMs, t.throttleCount, (deps.random ?? Math.random)())
  return defer(deps, t, ms, `${what} throttled (429); honoring Retry-After ${Math.ceil(retryAfterMs / 1000)}s, retry #${t.throttleCount + 1} in ${(ms / 1000).toFixed(1)}s`, 'throttle')
}

async function serverError(deps: ExecutorDeps, t: TargetRow, control: Control, what: string): Promise<ProcessOutcome> {
  if (t.attempts + 1 >= deps.maxAttempts) return finish(deps, t, control, 'failed', `Gave up after ${t.attempts + 1} attempts (last: ${what})`)
  return defer(deps, t, errorBackoffMs(t.attempts + 1, t.throttleCount), `${what}; not applied, retrying`, 'error')
}

export async function processTarget(deps: ExecutorDeps, targetId: number): Promise<ProcessOutcome> {
  const t = await deps.store.claim(targetId, deps.instanceId, deps.leaseMs)
  if (!t) return 'not_claimed'
  const started = deps.clock()
  const campaign = await deps.store.campaign(t.campaignId)
  if (!campaign) return 'not_claimed'
  const control = getControl(campaign.controlId)
  if (campaign.status === 'killed') return finish(deps, t, control, 'cancelled', 'Campaign was killed')
  if (campaign.status !== 'running') {
    await deps.store.release(t)
    return 'paused'
  }
  if (await deps.store.exceptionActive(t.accountId, control.id)) return finish(deps, t, control, 'skipped', 'Exception approved after the campaign was planned')

  const intentFromEarlierAttempt = t.beforeValue !== null && t.beforeValue !== undefined
  let conflicts = 0
  let afterConflict = false
  for (;;) {
    const wait = await acquireToken(deps, t.subscriptionId)
    if (wait > 0) return defer(deps, t, wait, 'Waiting for subscription write budget', 'budget')

    // 1. Re-read the live resource: the scan snapshot may be minutes or hours old.
    const current = await attempt(() => deps.arm.get(t.accountId, control.kind))
    if (current.status === 429) return throttled(deps, t, control, current.retryAfterMs ?? 1000, 'Read')
    if (current.status === 404) return finish(deps, t, control, 'skipped', 'Account no longer exists')
    if (current.status !== 200) return serverError(deps, t, control, current.status === 0 ? `Read got no response (${current.body.error?.message})` : `Read failed with HTTP ${current.status}`)
    const value = control.read(current.body.properties as never)

    // 2. Revalidate the plan's assumptions before committing to a change.
    if (!intentFromEarlierAttempt && !afterConflict) {
      const accountTags = control.kind === 'account' ? current.body.tags : undefined
      const planDecision = revalidatePlan({
        breaking: control.breaking,
        plannedRing: t.plannedRing,
        currentRing: accountTags?.env ? ringOf(accountTags.env) : null,
        evidenceClass: control.breaking ? await deps.store.currentEvidence(t.accountId, control.id) : null,
        includeClasses: campaign.includeClasses,
      })
      if (planDecision?.action === 'escalate') return finish(deps, t, control, 'escalated', planDecision.reason)
      if (planDecision?.action === 'skip') return finish(deps, t, control, 'skipped', planDecision.reason)
    }

    // 3. Decide against what is actually there.
    const decision = decideAfterRead({ compliant: control.isCompliant(value), current: value, recordedBefore: t.beforeValue, intentFromEarlierAttempt, afterConflict, conflicts, maxConflicts: MAX_CONFLICTS })
    if (decision.action === 'recovered') return applied(deps, t, control, value, current.etag ?? null, 'recovered', campaign.bakeSeconds)
    if (decision.action === 'skip') return finish(deps, t, control, 'skipped', decision.reason)
    if (decision.action === 'escalate') return finish(deps, t, control, 'escalated', decision.reason)

    // 4. Durable intent before the side effect.
    if (t.beforeValue === null || t.beforeValue === undefined) {
      const baseline = await measureBaseline(deps, t.accountId)
      const operationId = operationIdFor(t)
      if (!(await deps.store.recordIntent(t, { beforeValue: value, etagBefore: current.etag ?? null, baseline, operationId }))) return 'lost_lease'
      Object.assign(t, { beforeValue: value, etagBefore: current.etag ?? null, baseline, operationId })
    }

    // 5. Conditional write.
    const res = await attempt(() => deps.arm.write(t.accountId, control.kind, control.desired(value), current.etag, t.operationId ?? operationIdFor(t)))
    if (res.status === 200) {
      deps.afterWrite?.(t)
      applyDuration.observe((deps.clock() - started) / 1000)
      return applied(deps, t, control, control.read(res.body.properties as never), res.etag ?? null, 'written', campaign.bakeSeconds)
    }
    if (res.status === 412) {
      conflicts++
      afterConflict = true
      continue
    }
    if (res.status === 429) return throttled(deps, t, control, res.retryAfterMs ?? 1000, 'Write')
    if (res.status === 403) return finish(deps, t, control, 'failed', `Write refused: ${res.body.error?.message ?? 'forbidden'}`)
    if (res.status >= 500 || res.status === 0) {
      // Outcome unknown (server error, or the response was lost). Reconcile against actual state before any retry.
      const what = res.status === 0 ? `no response (${res.body.error?.message})` : `HTTP ${res.status}`
      const check = await attempt(() => deps.arm.get(t.accountId, control.kind))
      if (check.status === 200) {
        const after = control.read(check.body.properties as never)
        if (control.isCompliant(after)) return applied(deps, t, control, after, check.etag ?? null, res.status === 0 ? 'confirmed_after_timeout' : 'confirmed_after_5xx', campaign.bakeSeconds)
        return serverError(deps, t, control, `Write ${what}`)
      }
      // Couldn't even read: leave the outcome open; the retry starts with a read anyway.
      return serverError(deps, t, control, `Write ${what}, reconcile read ${check.status === 0 ? 'got no response' : `returned ${check.status}`}`)
    }
    return finish(deps, t, control, 'failed', `Write failed with HTTP ${res.status}`)
  }
}
