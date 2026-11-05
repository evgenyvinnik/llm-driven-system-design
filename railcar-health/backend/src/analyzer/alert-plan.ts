/**
 * Alert lifecycle decisions. One open alert per bearing per trip: new evidence
 * escalates it in place, never duplicates it, and never silently de-escalates
 * it (a bearing that cools after a braking zone still needs a human to close
 * the alert). Escalating an acknowledged alert reopens it for acknowledgement.
 * @module analyzer/alert-plan
 */
import { TIER } from '../shared/domain.js'

export interface ExistingAlert {
  tier: number
  status: 'open' | 'acknowledged' | 'closed'
}

export type AlertPlan =
  | { action: 'none' }
  | { action: 'open'; tier: number }
  | { action: 'escalate'; from: number; tier: number; reopen: boolean }
  | { action: 'refresh'; tier: number }

export function planAlertChange(existing: ExistingAlert | null, scoredTier: number): AlertPlan {
  if (!existing || existing.status === 'closed') {
    return scoredTier >= TIER.LOW ? { action: 'open', tier: scoredTier } : { action: 'none' }
  }
  if (scoredTier > existing.tier) {
    return { action: 'escalate', from: existing.tier, tier: scoredTier, reopen: existing.status === 'acknowledged' }
  }
  return { action: 'refresh', tier: existing.tier }
}

/** Holds and work orders start at MEDIUM: the car must not leave the next yard uninspected. */
export const needsHold = (tier: number) => tier >= TIER.MEDIUM
