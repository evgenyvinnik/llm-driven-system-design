/**
 * Snapshot compilation: the rows of one environment become one immutable,
 * self-contained document an SDK can evaluate offline. Pure, so the compiler
 * is unit-tested without a database.
 * @module domain/compile
 */
import type { Allocation, FlagKind, FlagStatus, Snapshot, SnapshotFlag, TargetingRule, UnitType, VariantDef } from '../shared/evaluation.js'

export interface CompilableFlag {
  key: string
  kind: FlagKind
  unitType: UnitType
  salt: string
  variants: VariantDef[]
  defaultVariant: string
  status: FlagStatus
  version: number
  rules: TargetingRule[]
  fallthrough: 'enroll' | 'exclude'
  allocation: Allocation
}

export function compileSnapshot(environment: string, version: number, flags: CompilableFlag[], compiledAt: Date = new Date()): Snapshot {
  const out: Record<string, SnapshotFlag> = {}
  for (const f of [...flags].sort((a, b) => a.key.localeCompare(b.key))) {
    out[f.key] = {
      key: f.key,
      kind: f.kind,
      unitType: f.unitType,
      salt: f.salt,
      status: f.status,
      version: f.version,
      variants: f.variants,
      defaultVariant: f.defaultVariant,
      rules: f.rules,
      fallthrough: f.fallthrough,
      allocation: f.allocation,
    }
  }
  return { schema: 1, environment, version, compiledAt: compiledAt.toISOString(), flags: out }
}

/** Snapshots are immutable per (environment, version), so the version is the entity tag. */
export function snapshotEtag(environment: string, version: number): string {
  return `"${environment}-v${version}"`
}

/** Does an If-None-Match header name this ETag (or *)? */
export function etagMatches(header: string | undefined, etag: string): boolean {
  if (!header) return false
  return header.split(',').some((t) => {
    const tag = t.trim().replace(/^W\//, '')
    return tag === '*' || tag === etag
  })
}
