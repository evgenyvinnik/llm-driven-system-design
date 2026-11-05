/**
 * Alert ownership. Delivered is not acknowledged: a notification provider
 * accepting a message says nothing about a person having read it. Every alert
 * that needs action has one owner (a dispatcher desk or a yard), a deadline to
 * acknowledge by, an escalation chain if nobody does, and an explicit handoff
 * when the train moves into another desk's territory or toward another yard.
 * @module analyzer/ownership
 */
import { ACK_DEADLINE_MINUTES, ESCALATION_CHAIN } from '../shared/domain.js'
import type { Routing } from './routing.js'

export type OwnerRole = 'dispatcher' | 'yard' | 'owner'

export interface Owner {
  role: OwnerRole
  id: string | null
}

/** Dispatchers own alerts that need the train handled; yards own the ones that need the car inspected. */
export function ownerFor(routing: Routing, deskId: string | null, yardId: string | null, ownerMark: string | null): Owner {
  if (routing === 'dispatcher_and_yard') return { role: 'dispatcher', id: deskId }
  if (routing === 'yard' || routing === 'yard_post_arrival') return { role: 'yard', id: yardId }
  return { role: 'owner', id: ownerMark }
}

export function ackDeadline(tier: number, role: OwnerRole, fromMs: number): Date | null {
  const minutes = ACK_DEADLINE_MINUTES[tier]
  if (minutes === null || minutes === undefined || role === 'owner') return null
  return new Date(fromMs + minutes * 60_000)
}

export interface EscalationInput {
  status: string
  role: OwnerRole
  level: number
  ackDueAtMs: number | null
  nowMs: number
  /** ETA of the train at the alert's yard, if it is heading there. */
  yardEtaMs: number | null
  approachWindowMinutes: number
  alreadyWarnedYard: boolean
}

export type EscalationDecision = { escalate: false } | { escalate: true; reason: 'ack_overdue' | 'approaching_yard'; toLevel: number }

export function decideEscalation(i: EscalationInput): EscalationDecision {
  if (i.status !== 'open' || i.role === 'owner') return { escalate: false }
  const maxLevel = ESCALATION_CHAIN[i.role].length - 1
  if (i.ackDueAtMs !== null && i.nowMs >= i.ackDueAtMs && i.level < maxLevel) {
    return { escalate: true, reason: 'ack_overdue', toLevel: i.level + 1 }
  }
  // Delivered but unacknowledged, and the train is about to reach the yard that must catch the car.
  if (!i.alreadyWarnedYard && i.yardEtaMs !== null && i.yardEtaMs - i.nowMs <= i.approachWindowMinutes * 60_000 && i.yardEtaMs >= i.nowMs) {
    return { escalate: true, reason: 'approaching_yard', toLevel: Math.max(i.level, 1) }
  }
  return { escalate: false }
}

export function escalationLabel(role: OwnerRole, level: number): string {
  if (role === 'owner') return 'car owner'
  const chain = ESCALATION_CHAIN[role]
  return chain[Math.min(level, chain.length - 1)]
}

/**
 * A handoff is needed when the owner of record is no longer the right one:
 * the train crossed into another desk's territory, or the car will now be
 * inspected at a different yard. The new owner must acknowledge afresh.
 */
export function needsHandoff(current: Owner, next: Owner): boolean {
  return current.role === next.role && current.role !== 'owner' && next.id !== null && current.id !== next.id
}
