/**
 * Turns control results for one account into finding writes: open or exempt
 * rows for failures (with evidence class, risk and due date), resolutions for
 * passes, and a flag when a previously resolved finding comes back (a regression).
 * @module domain/findings
 */
import { getControl, type ControlResult } from './controls.js'
import { classifyEvidence } from './evidence.js'
import { riskScore } from './risk.js'
import type { AccountSnapshot, EvidenceClass, Severity, UsageSummary } from './types.js'

export const SLA_DAYS: Record<Severity, number> = { critical: 7, high: 30, medium: 60, low: 90 }

export interface ExistingFinding {
  id: number
  controlId: string
  status: 'open' | 'resolved' | 'exempt'
  firstSeenAt: Date
}

export interface FindingWrite {
  accountId: string
  controlId: string
  controlVersion: number
  status: 'open' | 'exempt'
  severity: Severity
  riskScore: number
  observed: unknown
  evidenceClass: EvidenceClass
  evidenceReason: string
  dueAt: Date
  isNew: boolean
  reopened: boolean
}

export interface FindingPlan {
  writes: FindingWrite[]
  resolveIds: number[]
}

export function planFindings(
  snapshot: AccountSnapshot,
  results: ControlResult[],
  existing: Map<string, ExistingFinding>,
  usage: UsageSummary | null,
  exemptControls: Set<string>,
  now: Date,
  minEvidenceDays: number,
): FindingPlan {
  const writes: FindingWrite[] = []
  const resolveIds: number[] = []
  for (const result of results) {
    if (result.compliant === null) continue
    const prior = existing.get(result.controlId)
    if (result.compliant) {
      if (prior && prior.status !== 'resolved') resolveIds.push(prior.id)
      continue
    }
    const control = getControl(result.controlId)
    const evidence = classifyEvidence(control, usage, minEvidenceDays)
    const reopened = prior?.status === 'resolved'
    const firstSeen = prior && !reopened ? prior.firstSeenAt : now
    writes.push({
      accountId: snapshot.id,
      controlId: result.controlId,
      controlVersion: result.version,
      status: exemptControls.has(result.controlId) ? 'exempt' : 'open',
      severity: result.severity,
      riskScore: riskScore(result.severity, snapshot, evidence.evidenceClass),
      observed: result.observed,
      evidenceClass: evidence.evidenceClass,
      evidenceReason: evidence.reason,
      dueAt: new Date(firstSeen.getTime() + SLA_DAYS[result.severity] * 86_400_000),
      isNew: !prior,
      reopened,
    })
  }
  return { writes, resolveIds }
}
