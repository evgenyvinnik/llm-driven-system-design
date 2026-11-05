/**
 * In-memory target store with the same conditional-update semantics as the
 * PostgreSQL store (state guards, fences, leases), for unit tests.
 * @module executor/memory-store
 */
import type { MetricWindow } from '../domain/bake.js'
import type { EvidenceClass } from '../domain/types.js'
import type { CampaignInfo, DeferKind, FinishState, TargetRow, TargetState, TargetStore, WriteOutcome } from './types.js'

export interface MemoryAudit {
  action: string
  accountId: string
  before?: unknown
  after?: unknown
}

interface Stored extends TargetRow {
  leaseUntil: number | null
  notBefore: number | null
  lastError: string | null
}

export class MemoryTargetStore implements TargetStore {
  targets = new Map<number, Stored>()
  campaigns = new Map<string, CampaignInfo>()
  exceptions = new Set<string>()
  evidence = new Map<string, EvidenceClass>()
  auditLog: MemoryAudit[] = []

  constructor(private clock: () => number = Date.now) {}

  addTarget(partial: Partial<TargetRow> & Pick<TargetRow, 'id' | 'campaignId' | 'accountId' | 'subscriptionId'>): void {
    this.targets.set(partial.id, {
      waveNo: 1,
      state: 'queued',
      attempts: 0,
      throttleCount: 0,
      plannedRing: null,
      operationId: null,
      fence: 0,
      beforeValue: null,
      etagBefore: null,
      afterValue: null,
      etagAfter: null,
      baseline: null,
      appliedAt: null,
      bakeUntil: null,
      writeOutcome: null,
      rollbackReason: null,
      leaseUntil: null,
      notBefore: null,
      lastError: null,
      ...partial,
    })
  }

  get(id: number): Stored {
    const t = this.targets.get(id)
    if (!t) throw new Error(`no target ${id}`)
    return t
  }

  /** Simulates time passing until a held lease expires (a crashed worker). */
  expireLeases(): void {
    for (const t of this.targets.values()) if (t.leaseUntil !== null) t.leaseUntil = this.clock() - 1
  }

  private copy(t: Stored): TargetRow {
    return structuredClone({ ...t, leaseUntil: undefined, notBefore: undefined, lastError: undefined }) as TargetRow
  }

  private guard(t: TargetRow, states: TargetState[]): Stored | null {
    const s = this.targets.get(t.id)
    return s && s.fence === t.fence && states.includes(s.state) ? s : null
  }

  async claim(id: number, _owner: string, leaseMs: number): Promise<TargetRow | null> {
    const t = this.targets.get(id)
    const now = this.clock()
    if (!t) return null
    const due = t.state === 'queued' && (t.notBefore === null || t.notBefore <= now)
    const expired = t.state === 'applying' && t.leaseUntil !== null && t.leaseUntil < now
    if (!due && !expired) return null
    t.state = 'applying'
    t.fence += 1
    t.leaseUntil = now + leaseMs
    return this.copy(t)
  }

  async campaign(id: string): Promise<CampaignInfo | null> {
    return this.campaigns.get(id) ?? null
  }

  async exceptionActive(accountId: string, controlId: string): Promise<boolean> {
    return this.exceptions.has(`${accountId}|${controlId}`)
  }

  async currentEvidence(accountId: string, controlId: string): Promise<EvidenceClass | null> {
    return this.evidence.get(`${accountId}|${controlId}`) ?? 'safe_to_fix'
  }

  async recordIntent(t: TargetRow, intent: { beforeValue: unknown; etagBefore: string | null; baseline: MetricWindow; operationId: string }): Promise<boolean> {
    const s = this.guard(t, ['applying'])
    if (!s || s.beforeValue !== null) return false
    s.beforeValue = structuredClone(intent.beforeValue)
    s.etagBefore = intent.etagBefore
    s.baseline = intent.baseline
    s.operationId = intent.operationId
    return true
  }

  async markApplied(t: TargetRow, r: { afterValue: unknown; etagAfter: string | null; outcome: WriteOutcome; bakeUntil: Date }, _actor?: string, _controlId?: string): Promise<boolean> {
    const s = this.guard(t, ['applying'])
    if (!s) return false
    Object.assign(s, { state: 'baking', afterValue: r.afterValue, etagAfter: r.etagAfter, writeOutcome: r.outcome, appliedAt: new Date(this.clock()), bakeUntil: r.bakeUntil, leaseUntil: null })
    this.auditLog.push({ action: r.outcome === 'written' ? 'remediation.applied' : `remediation.applied.${r.outcome}`, accountId: t.accountId, before: s.beforeValue, after: r.afterValue })
    return true
  }

  async defer(t: TargetRow, notBefore: Date, reason: string, kind: DeferKind): Promise<boolean> {
    const s = this.guard(t, ['applying'])
    if (!s) return false
    Object.assign(s, {
      state: 'queued',
      notBefore: notBefore.getTime(),
      lastError: reason,
      leaseUntil: null,
      attempts: s.attempts + (kind === 'error' ? 1 : 0),
      throttleCount: s.throttleCount + (kind === 'throttle' ? 1 : 0),
    })
    return true
  }

  async release(t: TargetRow): Promise<boolean> {
    const s = this.guard(t, ['applying'])
    if (!s) return false
    Object.assign(s, { state: 'queued', leaseUntil: null })
    return true
  }

  async finish(t: TargetRow, state: FinishState, reason: string, _actor?: string, _controlId?: string): Promise<boolean> {
    const s = this.guard(t, ['applying', 'baking', 'rolling_back'])
    if (!s) return false
    Object.assign(s, { state, lastError: reason, leaseUntil: null })
    this.auditLog.push({ action: `remediation.${state}`, accountId: t.accountId })
    return true
  }

  async claimBaking(_owner: string, leaseMs: number, limit: number): Promise<TargetRow[]> {
    const now = this.clock()
    const out: TargetRow[] = []
    for (const t of this.targets.values()) {
      if (out.length >= limit) break
      if ((t.state === 'baking' || t.state === 'rolling_back') && (t.leaseUntil === null || t.leaseUntil < now)) {
        t.fence += 1
        t.leaseUntil = now + leaseMs
        out.push(this.copy(t))
      }
    }
    return out
  }

  async releaseBaking(t: TargetRow, countAttempt = false): Promise<void> {
    const s = this.targets.get(t.id)
    if (s && s.fence === t.fence) {
      s.leaseUntil = null
      if (countAttempt) s.attempts += 1
    }
  }

  async startRollback(t: TargetRow, reason: string, _actor?: string, _controlId?: string): Promise<boolean> {
    const s = this.guard(t, ['baking'])
    if (!s) return false
    Object.assign(s, { state: 'rolling_back', rollbackReason: reason })
    this.auditLog.push({ action: 'remediation.rollback_triggered', accountId: t.accountId })
    return true
  }

  async markRolledBack(t: TargetRow, r: { restoredValue: unknown; etagAfter: string | null }, _actor?: string, _controlId?: string): Promise<boolean> {
    const s = this.guard(t, ['rolling_back'])
    if (!s) return false
    Object.assign(s, { state: 'rolled_back', etagAfter: r.etagAfter, leaseUntil: null })
    this.auditLog.push({ action: 'remediation.rolled_back', accountId: t.accountId, before: s.afterValue, after: r.restoredValue })
    return true
  }

  async markVerified(t: TargetRow, _actor?: string, _controlId?: string): Promise<boolean> {
    const s = this.guard(t, ['baking'])
    if (!s) return false
    Object.assign(s, { state: 'verified', leaseUntil: null })
    this.auditLog.push({ action: 'remediation.verified', accountId: t.accountId })
    return true
  }
}
