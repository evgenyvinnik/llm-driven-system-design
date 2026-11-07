/**
 * The one evaluation function. The server's evaluate endpoint, the browser SDK
 * and the Node SDK all call this with the same snapshot, so a unit gets the
 * same variant everywhere (parity is tested on random units).
 *
 * Order: status → unit id → targeting rules (first match wins) → bucket → range.
 * @module core/evaluate
 */
import { variantAt } from './allocation.js'
import { bucketOf } from './hash.js'
import { ruleMatches } from './targeting.js'
import type { EvalContext, Evaluation, JsonValue, Snapshot, SnapshotFlag, UnitType } from './types.js'

/**
 * Which id buckets a unit for each unit type.
 *
 * `user` uses `stableId`: the anonymous id while signed out and, after sign-in,
 * the identity alias the server returned (the first anonymous id that user
 * signed in from). So an anonymous visitor keeps their variant when they sign
 * in, and every device the user signs in on converges on the same bucket.
 * `anonymous` is device-scoped and never changes on sign-in. `org` needs an org.
 */
export function resolveUnit(unitType: UnitType, ctx: EvalContext): string | undefined {
  switch (unitType) {
    case 'user':
      return ctx.stableId || ctx.userId || ctx.anonymousId || undefined
    case 'org':
      return ctx.orgId || undefined
    case 'anonymous':
      return ctx.anonymousId || undefined
  }
}

function valueOf(flag: SnapshotFlag, variant: string): JsonValue | undefined {
  return flag.variants.find((v) => v.key === variant)?.value
}

export function evaluateFlag(flag: SnapshotFlag, ctx: EvalContext): Evaluation {
  const base = { key: flag.key, unitType: flag.unitType, version: flag.version }
  const fallback = (reason: Evaluation['reason'], extra: Partial<Evaluation> = {}): Evaluation => ({
    ...base,
    variant: flag.defaultVariant,
    value: valueOf(flag, flag.defaultVariant),
    reason,
    inExperiment: false,
    ...extra,
  })

  if (flag.status !== 'running') return fallback('inactive')
  const unitId = resolveUnit(flag.unitType, ctx)
  if (!unitId) return fallback('no_unit')

  let enroll = flag.fallthrough === 'enroll'
  let ruleId: string | undefined
  let matched = false
  for (const rule of flag.rules) {
    if (!ruleMatches(rule, ctx, unitId)) continue
    matched = true
    ruleId = rule.id
    if (rule.action.type === 'force') {
      return { ...base, variant: rule.action.variant, value: valueOf(flag, rule.action.variant), reason: 'forced', inExperiment: false, unitId, ruleId }
    }
    if (rule.action.type === 'exclude') return fallback('excluded', { unitId, ruleId })
    enroll = true
    break
  }
  if (!enroll) return fallback(matched ? 'excluded' : 'not_targeted', { unitId })

  const bucket = bucketOf(flag.salt, unitId)
  const variant = variantAt(flag.allocation, bucket)
  if (!variant) return fallback('not_allocated', { unitId, bucket, ruleId })
  return {
    ...base,
    variant,
    value: valueOf(flag, variant),
    reason: 'allocated',
    inExperiment: flag.kind === 'experiment',
    unitId,
    bucket,
    ruleId,
  }
}

/** Evaluates a key against a snapshot; an unknown key yields `unknown_flag` with no variant. */
export function evaluate(snapshot: Snapshot | null | undefined, key: string, ctx: EvalContext): Evaluation {
  const flag = snapshot?.flags[key]
  if (!flag) return { key, variant: null, value: undefined, reason: 'unknown_flag', inExperiment: false }
  return evaluateFlag(flag, ctx)
}
