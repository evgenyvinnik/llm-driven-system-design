/**
 * Targeting rule matching. Conditions inside a rule are ANDed; values inside a
 * condition are ORed. A missing attribute never matches `in` and always
 * matches `not_in`, so "country not in [DE]" includes units with no country.
 * @module core/targeting
 */
import type { Condition, EvalContext, TargetingRule } from './types.js'

/** Identity attributes resolve from the context ids; everything else from `attributes`. */
export function attributeValue(attribute: string, ctx: EvalContext, unitId: string | undefined): string | undefined {
  switch (attribute) {
    case 'id':
      return unitId
    case 'userId':
      return ctx.userId
    case 'anonymousId':
      return ctx.anonymousId
    case 'orgId':
      return ctx.orgId
    default:
      return ctx.attributes?.[attribute]
  }
}

export function conditionMatches(condition: Condition, ctx: EvalContext, unitId: string | undefined): boolean {
  const value = attributeValue(condition.attribute, ctx, unitId)
  const listed = value !== undefined && condition.values.includes(value)
  return condition.operator === 'in' ? listed : !listed
}

export function ruleMatches(rule: TargetingRule, ctx: EvalContext, unitId: string | undefined): boolean {
  return rule.conditions.every((c) => conditionMatches(c, ctx, unitId))
}
