/**
 * Risk-based prioritization: severity × internet exposure × data classification
 * × whether the insecure path is actually in use. Produces 0-100.
 * @module domain/risk
 */
import type { AccountSnapshot, EvidenceClass, Severity } from './types.js'

const SEVERITY: Record<Severity, number> = { critical: 1, high: 0.75, medium: 0.5, low: 0.25 }
const CLASSIFICATION: Record<string, number> = { restricted: 1, confidential: 0.8, internal: 0.5, public: 0.3 }

export function exposureFactor(snapshot: AccountSnapshot): number {
  const p = snapshot.properties
  if (p.publicNetworkAccess === 'Disabled') return 0.2
  return p.networkAcls.defaultAction === 'Allow' ? 1 : 0.5
}

/** Untagged data is treated as sensitive: missing classification is not a reason to deprioritize. */
export function classificationFactor(snapshot: AccountSnapshot): number {
  return CLASSIFICATION[(snapshot.tags.dataClassification ?? '').toLowerCase()] ?? 0.8
}

/** An insecure path that is being used right now is worse than one that merely exists. */
export function usageFactor(evidence: EvidenceClass | null): number {
  if (evidence === 'needs_owner_migration') return 1
  if (evidence === 'insufficient_evidence' || evidence === null) return 0.7
  return 0.5
}

export function riskScore(severity: Severity, snapshot: AccountSnapshot, evidence: EvidenceClass | null): number {
  return Math.round(100 * SEVERITY[severity] * exposureFactor(snapshot) * classificationFactor(snapshot) * usageFactor(evidence))
}
