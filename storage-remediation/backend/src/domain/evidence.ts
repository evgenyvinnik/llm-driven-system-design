/**
 * Impact analysis: given an account's recent access logs, can a breaking
 * control be turned on without breaking a caller?
 *
 * The rules that matter:
 * - No logs is not "no usage". An account without a diagnostic setting, or one
 *   whose logging started recently, has insufficient evidence.
 * - Shared key dependency is AccountKey requests plus SAS requests (service and
 *   account SAS are signed with the account key). OAuth is the migration target.
 * - Non-breaking controls (soft delete, diagnostics) are always safe to fix.
 * @module domain/evidence
 */
import type { Control } from './controls.js'
import type { EvidenceClass, UsageCaller, UsageSummary } from './types.js'

export interface EvidenceDecision {
  evidenceClass: EvidenceClass
  reason: string
  /** Requests in the window that would fail after the change. */
  dependentRequests: number
  topCallers: UsageCaller[]
}

export function dependentCount(control: Control, usage: UsageSummary): number {
  switch (control.dependency) {
    case 'sharedKey':
      return usage.counts.accountKey + usage.counts.sas
    case 'anonymous':
      return usage.counts.anonymous
    case 'legacyTls':
      return usage.counts.legacyTls
    case 'http':
      return usage.counts.http
    case 'publicNetwork':
      return usage.counts.publicNetwork
    default:
      return 0
  }
}

function callerDepends(control: Control, caller: UsageCaller): boolean {
  switch (control.dependency) {
    case 'sharedKey':
      return caller.authType === 'AccountKey' || caller.authType === 'SAS'
    case 'anonymous':
      return caller.authType === 'Anonymous'
    case 'legacyTls':
      return caller.tlsVersion === 'TLS 1.0' || caller.tlsVersion === 'TLS 1.1'
    case 'http':
      return caller.protocol === 'HTTP'
    case 'publicNetwork':
      return !isPrivateIp(caller.callerIp)
    default:
      return false
  }
}

export function isPrivateIp(ip: string): boolean {
  return /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip)
}

const DAY = 86_400_000

/**
 * How many days of logs exist for an account: none without a diagnostic
 * setting, and never more than the time since logging started.
 */
export function evidenceWindow(diagnostics: { enabled: boolean; createdAt: string | null } | null, lookbackDays: number, now: number): { hasLogs: boolean; windowDays: number } {
  if (!diagnostics || !diagnostics.enabled || !diagnostics.createdAt) return { hasLogs: false, windowDays: 0 }
  const days = Math.floor((now - Date.parse(diagnostics.createdAt)) / DAY)
  return { hasLogs: true, windowDays: Math.max(0, Math.min(lookbackDays, days)) }
}

/** Folds aggregated log rows into the counts each control's dependency check reads. */
export function summarizeUsage(rows: UsageCaller[], window: { hasLogs: boolean; windowDays: number }): UsageSummary {
  const counts = { anonymous: 0, sas: 0, accountKey: 0, oauth: 0, legacyTls: 0, http: 0, publicNetwork: 0, total: 0 }
  for (const r of rows) {
    counts.total += r.requests
    if (r.authType === 'Anonymous') counts.anonymous += r.requests
    else if (r.authType === 'SAS') counts.sas += r.requests
    else if (r.authType === 'AccountKey') counts.accountKey += r.requests
    else counts.oauth += r.requests
    if (r.tlsVersion === 'TLS 1.0' || r.tlsVersion === 'TLS 1.1') counts.legacyTls += r.requests
    if (r.protocol === 'HTTP') counts.http += r.requests
    if (!isPrivateIp(r.callerIp)) counts.publicNetwork += r.requests
  }
  const callers = [...rows].sort((a, b) => b.requests - a.requests).slice(0, 20)
  return { hasLogs: window.hasLogs, windowDays: window.windowDays, counts, callers }
}

/** Average requests per minute over the window: the wave planner's blast-radius proxy. */
export function trafficPerMinute(usage: UsageSummary): number {
  if (!usage.hasLogs || usage.windowDays <= 0) return 0
  return Math.round((usage.counts.total / (usage.windowDays * 1440)) * 10) / 10
}

export function classifyEvidence(control: Control, usage: UsageSummary | null, minEvidenceDays: number): EvidenceDecision {
  if (!control.breaking) {
    return { evidenceClass: 'safe_to_fix', reason: 'Additive change: nothing that works today stops working', dependentRequests: 0, topCallers: [] }
  }
  if (!usage || !usage.hasLogs) {
    return {
      evidenceClass: 'insufficient_evidence',
      reason: 'No access logs: enable diagnostics (SA-07) first, then wait for a full evidence window',
      dependentRequests: 0,
      topCallers: [],
    }
  }
  const dependent = dependentCount(control, usage)
  const topCallers = usage.callers
    .filter((c) => callerDepends(control, c))
    .sort((a, b) => b.requests - a.requests)
    .slice(0, 5)
  if (dependent > 0) {
    return {
      evidenceClass: 'needs_owner_migration',
      reason: `${dependent.toLocaleString('en-US')} requests in ${usage.windowDays}d depend on the insecure setting (${topCallers.length} caller${topCallers.length === 1 ? '' : 's'})`,
      dependentRequests: dependent,
      topCallers,
    }
  }
  if (usage.windowDays < minEvidenceDays) {
    return {
      evidenceClass: 'insufficient_evidence',
      reason: `Only ${usage.windowDays}d of logs (need ${minEvidenceDays}d) since logging started`,
      dependentRequests: 0,
      topCallers: [],
    }
  }
  return {
    evidenceClass: 'safe_to_fix',
    reason: `No dependent requests in ${usage.windowDays}d of logs (${usage.counts.total.toLocaleString('en-US')} requests seen)`,
    dependentRequests: 0,
    topCallers: [],
  }
}
