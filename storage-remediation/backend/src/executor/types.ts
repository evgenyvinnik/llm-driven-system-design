/**
 * Campaign target state machine and the storage interface the executor logic
 * depends on. The PostgreSQL store is used at runtime; an in-memory store with
 * the same semantics backs the unit tests (crash/resume, fencing, rollback).
 *
 *   pending ─▶ queued ─▶ applying ─▶ baking ─▶ verified
 *                ▲          │  │        │
 *                └─deferred─┘  │        └──▶ rolling_back ─▶ rolled_back
 *                              └──▶ skipped | escalated | failed | cancelled
 *
 * escalated: the resource or the plan changed in a way a human must look at
 * (environment moved to prod, someone else is changing the same property).
 * It does not count against the wave's failure budget; failed does.
 * @module executor/types
 */
import type { MetricWindow } from '../domain/bake.js'
import type { EvidenceClass, Ring } from '../domain/types.js'

export type TargetState = 'pending' | 'queued' | 'applying' | 'baking' | 'rolling_back' | 'verified' | 'rolled_back' | 'skipped' | 'escalated' | 'failed' | 'cancelled'

export const TERMINAL_STATES: TargetState[] = ['verified', 'rolled_back', 'skipped', 'escalated', 'failed', 'cancelled']

export type FinishState = 'skipped' | 'escalated' | 'failed' | 'cancelled'

/** Why a target goes back to the queue; each kind has its own counter and bound. */
export type DeferKind = 'budget' | 'throttle' | 'error'

export type CampaignStatus = 'draft' | 'running' | 'paused' | 'completed' | 'killed'

export type WriteOutcome = 'written' | 'recovered' | 'confirmed_after_5xx' | 'confirmed_after_timeout'

export interface TargetRow {
  id: number
  campaignId: string
  accountId: string
  subscriptionId: string
  waveNo: number
  state: TargetState
  attempts: number
  throttleCount: number
  /** The ring (nonprod/prod) the target was planned in; re-checked against the live env tag before writing. */
  plannedRing: Ring | null
  operationId: string | null
  /** Incremented on every claim; updates carry it so a worker whose lease expired changes nothing. */
  fence: number
  beforeValue: unknown
  etagBefore: string | null
  afterValue: unknown
  etagAfter: string | null
  baseline: MetricWindow | null
  appliedAt: Date | null
  bakeUntil: Date | null
  writeOutcome: string | null
  rollbackReason: string | null
}

export interface CampaignInfo {
  id: string
  controlId: string
  status: CampaignStatus
  bakeSeconds: number
  includeClasses: EvidenceClass[]
}

export interface TargetStore {
  /** queued (and due) or applying-with-expired-lease → applying, fence + 1. */
  claim(id: number, owner: string, leaseMs: number): Promise<TargetRow | null>
  campaign(id: string): Promise<CampaignInfo | null>
  exceptionActive(accountId: string, controlId: string): Promise<boolean>
  /** The finding's evidence class right now (it may have changed since planning). */
  currentEvidence(accountId: string, controlId: string): Promise<EvidenceClass | null>
  /** Durable intent before the write. Only sets values once; never overwrites an earlier before-value. */
  recordIntent(t: TargetRow, intent: { beforeValue: unknown; etagBefore: string | null; baseline: MetricWindow; operationId: string }): Promise<boolean>
  markApplied(t: TargetRow, r: { afterValue: unknown; etagAfter: string | null; outcome: WriteOutcome; bakeUntil: Date }, actor: string, controlId: string): Promise<boolean>
  defer(t: TargetRow, notBefore: Date, reason: string, kind: DeferKind): Promise<boolean>
  release(t: TargetRow): Promise<boolean>
  finish(t: TargetRow, state: FinishState, reason: string, actor: string, controlId: string): Promise<boolean>
  /** baking/rolling_back targets with no live lease, leased to `owner`. */
  claimBaking(owner: string, leaseMs: number, limit: number): Promise<TargetRow[]>
  /** Releases the bake lease; countAttempt records a failed rollback round (rollbacks are bounded too). */
  releaseBaking(t: TargetRow, countAttempt?: boolean): Promise<void>
  startRollback(t: TargetRow, reason: string, actor: string, controlId: string): Promise<boolean>
  markRolledBack(t: TargetRow, r: { restoredValue: unknown; etagAfter: string | null; outcome: 'written' | 'already_restored' }, actor: string, controlId: string): Promise<boolean>
  markVerified(t: TargetRow, actor: string, controlId: string): Promise<boolean>
}

export interface CampaignEvent {
  type: string
  accountId?: string
  waveNo?: number
  message?: string
  [key: string]: unknown
}
