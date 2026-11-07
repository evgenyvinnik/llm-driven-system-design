/**
 * Validation and rules for flags, experiments and their per-environment configs:
 * request schemas, the status state machine, cross-field checks and the
 * human-readable change summary written to the audit log.
 * @module domain/flag-model
 */
import { z } from 'zod'
import {
  BUCKETS,
  compareAllocations,
  weightsOf,
  type Allocation,
  type FlagKind,
  type FlagStatus,
  type TargetingRule,
  type VariantDef,
} from '../shared/evaluation.js'

/** draft → running → paused ⇄ running → stopped. Stopped is final: a rerun is a new experiment (new key, new salt). */
export const TRANSITIONS: Record<FlagStatus, FlagStatus[]> = {
  draft: ['running', 'stopped'],
  running: ['paused', 'stopped'],
  paused: ['running', 'stopped'],
  stopped: [],
}

export function canTransition(from: FlagStatus, to: FlagStatus): boolean {
  return TRANSITIONS[from].includes(to)
}

/** What the kill switch does: force a flag off (resumable), stop an experiment (final). */
export function killTarget(kind: FlagKind): FlagStatus {
  return kind === 'flag' ? 'paused' : 'stopped'
}

const flagKey = z.string().regex(/^[a-z][a-z0-9_]{1,63}$/, 'lowercase letters, digits and _; 2-64 chars, starting with a letter')
const variantKey = z.string().regex(/^[a-z][a-z0-9_]{0,31}$/, 'lowercase letters, digits and _')
const primitive = z.union([z.string().max(200), z.number(), z.boolean(), z.null()])

export const variantSchema = z.object({ key: variantKey, name: z.string().min(1).max(60), value: primitive.optional() }).strict()

export const conditionSchema = z
  .object({
    attribute: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,31}$/),
    operator: z.enum(['in', 'not_in']),
    values: z.array(z.string().min(1).max(128)).min(1).max(1000),
  })
  .strict()

export const ruleSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9_-]{1,40}$/),
    description: z.string().max(120).default(''),
    conditions: z.array(conditionSchema).max(10),
    action: z.discriminatedUnion('type', [
      z.object({ type: z.literal('enroll') }).strict(),
      z.object({ type: z.literal('exclude') }).strict(),
      z.object({ type: z.literal('force'), variant: variantKey }).strict(),
    ]),
  })
  .strict()

export const createFlagSchema = z
  .object({
    key: flagKey,
    kind: z.enum(['flag', 'experiment']),
    name: z.string().min(1).max(80),
    description: z.string().max(500).default(''),
    unitType: z.enum(['user', 'org', 'anonymous']),
    variants: z.array(variantSchema).min(2).max(6).optional(),
    primaryMetric: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/).default('purchase'),
    attributionWindowHours: z.number().int().min(1).max(720).default(72),
    surface: z.string().max(120).default(''),
  })
  .strict()

export const metadataSchema = z
  .object({
    name: z.string().min(1).max(80),
    description: z.string().max(500),
    primaryMetric: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
    attributionWindowHours: z.number().int().min(1).max(720),
    surface: z.string().max(120),
  })
  .partial()
  .strict()

/** Weights are in buckets (basis points): 1000 = 10%. Their sum may be below 10000; the rest is not enrolled. */
export const updateConfigSchema = z
  .object({
    weights: z.record(variantKey, z.number().int().min(0).max(BUCKETS)).optional(),
    rules: z.array(ruleSchema).max(20).optional(),
    fallthrough: z.enum(['enroll', 'exclude']).optional(),
  })
  .strict()

export const statusSchema = z.object({ to: z.enum(['draft', 'running', 'paused', 'stopped']), reason: z.string().max(200).optional() }).strict()
export const killSchema = z.object({ reason: z.string().min(1).max(200) }).strict()

/** Default variants when none are given: off/on for a flag, control/treatment for an experiment. */
export function defaultVariants(kind: FlagKind): VariantDef[] {
  return kind === 'flag'
    ? [
        { key: 'off', name: 'Off', value: false },
        { key: 'on', name: 'On', value: true },
      ]
    : [
        { key: 'control', name: 'Control' },
        { key: 'treatment', name: 'Treatment' },
      ]
}

/** Initial weights: a flag starts at 0% on; an experiment splits 100% evenly. */
export function initialWeights(kind: FlagKind, variants: VariantDef[]): Record<string, number> {
  if (kind === 'flag') return { [variants[1].key]: 0 }
  const each = Math.floor(BUCKETS / variants.length)
  const weights: Record<string, number> = {}
  variants.forEach((v, i) => {
    weights[v.key] = i === 0 ? BUCKETS - each * (variants.length - 1) : each
  })
  return weights
}

/** Cross-field checks: every variant referenced by a weight or a rule must exist. */
export function checkConfigReferences(variants: VariantDef[], weights: Record<string, number> | undefined, rules: TargetingRule[] | undefined): string | null {
  const known = new Set(variants.map((v) => v.key))
  for (const key of Object.keys(weights ?? {})) if (!known.has(key)) return `unknown variant "${key}" in weights`
  const ids = new Set<string>()
  for (const rule of rules ?? []) {
    if (ids.has(rule.id)) return `duplicate rule id "${rule.id}"`
    ids.add(rule.id)
    if (rule.action.type === 'force' && !known.has(rule.action.variant)) return `rule "${rule.id}" forces unknown variant "${rule.action.variant}"`
  }
  return null
}

const pct = (buckets: number) => `${(buckets / 100).toFixed(buckets % 100 === 0 ? 0 : 2)}%`

/** One-line audit summary of a config change, including how many units the new ranges move. */
export function describeConfigChange(
  before: { allocation: Allocation; rules: TargetingRule[]; fallthrough: string },
  after: { allocation: Allocation; rules: TargetingRule[]; fallthrough: string },
): string {
  const parts: string[] = []
  const wb = weightsOf(before.allocation)
  const wa = weightsOf(after.allocation)
  const changedWeights = [...new Set([...Object.keys(wb), ...Object.keys(wa)])].filter((v) => (wb[v] ?? 0) !== (wa[v] ?? 0))
  if (changedWeights.length > 0) {
    const move = compareAllocations(before.allocation, after.allocation)
    const flows = move.transitions.map((t) => `${t.from ?? 'not enrolled'}→${t.to ?? 'not enrolled'} ${pct(t.buckets)}`).join(', ')
    parts.push(`weights ${changedWeights.map((v) => `${v} ${pct(wb[v] ?? 0)}→${pct(wa[v] ?? 0)}`).join(', ')} (moves ${pct(move.changed)} of units: ${flows})`)
  }
  if (JSON.stringify(before.rules) !== JSON.stringify(after.rules)) parts.push(`targeting ${before.rules.length}→${after.rules.length} rules`)
  if (before.fallthrough !== after.fallthrough) parts.push(`fallthrough ${before.fallthrough}→${after.fallthrough}`)
  return parts.length > 0 ? parts.join('; ') : 'no effective change'
}
