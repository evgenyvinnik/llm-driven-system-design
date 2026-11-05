/**
 * The resource may have changed since discovery. Right before every write the
 * executor re-reads it (ARM, not the scan snapshot) and decides deliberately:
 *
 * Plan preconditions (before any intent is recorded):
 * - the environment moved rings since planning (dev → prod): escalate; the
 *   account no longer belongs in this wave's blast-radius budget
 * - the evidence class changed (a caller appeared): skip; the owner workflow takes it
 *
 * After the read, and after any 412 on the write:
 * - compliant, no intent recorded: someone else fixed it → skip
 * - compliant, intent from an earlier attempt: our earlier write landed → recovered
 * - compliant right after our write was rejected with 412: fixed concurrently → skip
 * - still non-compliant with the value we recorded: an unrelated property
 *   changed → recompute the write against the new etag
 * - non-compliant with a different value than we recorded (TLS1_0 → TLS1_1):
 *   someone is actively managing this property → escalate, don't fight them
 * - too many conflicts in a row → escalate
 * @module domain/revalidate
 */
import { isDeepStrictEqual } from 'node:util'
import type { EvidenceClass, Ring } from './types.js'

export type Decision = { action: 'write' } | { action: 'recovered' } | { action: 'skip'; reason: string } | { action: 'escalate'; reason: string }

export interface PlanCheck {
  breaking: boolean
  plannedRing: Ring | null
  currentRing: Ring | null
  evidenceClass: EvidenceClass | null
  includeClasses: EvidenceClass[]
}

/** Re-validates the plan's assumptions on the first attempt. Returns null when they still hold. */
export function revalidatePlan(c: PlanCheck): Decision | null {
  if (c.plannedRing && c.currentRing && c.plannedRing !== c.currentRing) {
    return { action: 'escalate', reason: `Environment changed since planning (planned in ${c.plannedRing}, now ${c.currentRing}); re-plan this account` }
  }
  if (c.breaking && c.evidenceClass && !c.includeClasses.includes(c.evidenceClass)) {
    return { action: 'skip', reason: `Evidence changed since planning (now ${c.evidenceClass}); handed to the owner workflow` }
  }
  return null
}

export interface ReadCheck {
  compliant: boolean
  current: unknown
  /** Before-value recorded as intent (null when no intent yet). */
  recordedBefore: unknown
  /** Intent was recorded by an earlier attempt (crash, lost response), not this one. */
  intentFromEarlierAttempt: boolean
  /** This attempt's write was just rejected with 412. */
  afterConflict: boolean
  conflicts: number
  maxConflicts: number
}

export function decideAfterRead(c: ReadCheck): Decision {
  const hasIntent = c.recordedBefore !== null && c.recordedBefore !== undefined
  if (c.compliant) {
    if (c.afterConflict) return { action: 'skip', reason: 'Fixed concurrently by someone else (our write was rejected with 412, the resource is now compliant)' }
    if (hasIntent && c.intentFromEarlierAttempt) return { action: 'recovered' }
    return { action: 'skip', reason: 'Already compliant (fixed outside this campaign)' }
  }
  if (c.conflicts >= c.maxConflicts) return { action: 'escalate', reason: `Resource changed ${c.conflicts} times during the write (repeated 412s); someone is actively changing it` }
  if (hasIntent && !isDeepStrictEqual(c.current, c.recordedBefore)) {
    return { action: 'escalate', reason: `Property changed concurrently from ${JSON.stringify(c.recordedBefore)} to ${JSON.stringify(c.current)}; not overriding another writer` }
  }
  return { action: 'write' }
}

/** Back-off for server errors and timeouts, longer while the subscription is also being throttled. */
export function errorBackoffMs(attempts: number, throttles: number): number {
  return Math.min(60_000, 1000 * 2 ** Math.max(0, attempts - 1) * 2 ** Math.min(throttles, 3))
}

/** Back-off after a 429: at least Retry-After, growing with consecutive throttles, plus jitter to break up herds. */
export function throttleBackoffMs(retryAfterMs: number, throttles: number, jitter: number): number {
  return Math.max(retryAfterMs, Math.min(60_000, 500 * 2 ** throttles)) + Math.round(jitter * 500)
}
