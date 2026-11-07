/**
 * Shapes shared by the server (compiler, evaluate endpoint, analysis) and the
 * SDK (local evaluation). A snapshot is the compiled, immutable ruleset of one
 * environment at one version; everything an SDK needs to evaluate offline.
 * @module core/types
 */

/** Units are hashed into [0, BUCKETS). Variants own bucket ranges. 1 bucket = 0.01%. */
export const BUCKETS = 10_000

export type UnitType = 'user' | 'org' | 'anonymous'
export type FlagKind = 'flag' | 'experiment'
export type FlagStatus = 'draft' | 'running' | 'paused' | 'stopped'

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }

/** Half-open bucket range [start, end). */
export type Range = [number, number]

/** Variant key → the bucket ranges it owns. Buckets owned by nobody are "not allocated". */
export type Allocation = Record<string, Range[]>

export interface VariantDef {
  key: string
  name: string
  value?: JsonValue
}

export type ConditionOperator = 'in' | 'not_in'

/**
 * `attribute` is a context attribute (country, plan, platform, …) or one of the
 * identity attributes: `id` (the bucketing unit id), `userId`, `anonymousId`, `orgId`.
 */
export interface Condition {
  attribute: string
  operator: ConditionOperator
  values: string[]
}

export type RuleAction =
  | { type: 'enroll' }
  | { type: 'force'; variant: string }
  | { type: 'exclude' }

/** Rules are evaluated in order; the first whose conditions all match decides. */
export interface TargetingRule {
  id: string
  description: string
  conditions: Condition[]
  action: RuleAction
}

export interface SnapshotFlag {
  key: string
  kind: FlagKind
  unitType: UnitType
  salt: string
  status: FlagStatus
  /** Version of this flag's config in this environment; bumps on every change. */
  version: number
  variants: VariantDef[]
  /** Served whenever the unit is not enrolled: inactive, excluded, not allocated. */
  defaultVariant: string
  rules: TargetingRule[]
  /** What happens to units that match no rule. */
  fallthrough: 'enroll' | 'exclude'
  allocation: Allocation
}

export interface Snapshot {
  schema: 1
  environment: string
  /** Monotonic per environment; bumps whenever any flag in it changes. */
  version: number
  compiledAt: string
  flags: Record<string, SnapshotFlag>
}

/** Who is being evaluated. The SDK fills `stableId` (see evaluate.resolveUnit). */
export interface EvalContext {
  anonymousId?: string
  userId?: string
  /** Canonical person id for `user` experiments: the anonymous id until sign-in, then the identity alias. */
  stableId?: string
  orgId?: string
  attributes?: Record<string, string | undefined>
}

export type EvalReason =
  | 'unknown_flag'
  | 'inactive'
  | 'no_unit'
  | 'forced'
  | 'excluded'
  | 'not_targeted'
  | 'not_allocated'
  | 'allocated'
  /** The SDK had no snapshot at all and served the coded default. */
  | 'default'

export interface Evaluation {
  key: string
  variant: string | null
  value: JsonValue | undefined
  reason: EvalReason
  /** True only for an experiment unit bucketed into a variant: the only case that may log exposure. */
  inExperiment: boolean
  unitType?: UnitType
  unitId?: string
  bucket?: number
  /** Flag config version the evaluation used (exposures are deduped per unit per version). */
  version?: number
  ruleId?: string
}
