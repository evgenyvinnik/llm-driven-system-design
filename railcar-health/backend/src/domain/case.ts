/**
 * The case aggregate: one alert (or one random audit) and the yard's response
 * to it: hold, work order, finding, closure. It is event-sourced. Its state is
 * the fold of its stream (case-<uuid>); the alerts, car_holds, work_orders,
 * findings and notifications tables are projections of these events.
 *
 * Everything here is pure: deciders take the current state and a command and
 * return new events (or throw a DomainError). Repositories load and append.
 *
 * Invariants the aggregate protects:
 *  - a tier only goes up; a closed case takes no new decisions;
 *  - only the owner acknowledges, and a stale view of a decision is refused;
 *  - one hold and one work order per case; a finding needs the work order;
 *  - a defect report is never overwritten by a no-defect report (offline tablets);
 *  - each notification is requested once per (channel, target, kind).
 * @module domain/case
 */
import { randomUUID } from 'node:crypto'
import { DECISION_EVENTS } from '../events/catalog.js'
import type { NewEvent } from '../events/store.js'

export type CaseStatus = 'open' | 'acknowledged' | 'inspected' | 'closed'
export type OwnerRole = 'dispatcher' | 'yard' | 'owner'
export interface Owner {
  role: OwnerRole
  id: string | null
}

export interface CaseFinding {
  findingId: string
  clientSubmissionId: string | null
  finding: string
  disposition: string
  source: string
  supersededBy: string | null
}

export interface CaseState {
  caseId: string
  version: number
  exists: boolean
  caseType: 'alert' | 'audit' | null
  tripId: string | null
  symbol: string | null
  carId: string | null
  ownerMark: string | null
  kind: string | null
  position: string | null
  tier: number
  status: CaseStatus
  owner: Owner | null
  escalationLevel: number
  ackDueAt: string | null
  routing: string | null
  deskId: string | null
  territoryId: string | null
  yardId: string | null
  deliveredAt: string | null
  acknowledgedAt: string | null
  acknowledgedBy: string | null
  warnedYards: string[]
  hold: { holdId: string; yardId: string; status: 'active' | 'bad_ordered' | 'released' } | null
  workOrder: { workOrderId: string; yardId: string; status: 'open' | 'in_progress' | 'completed' | 'cancelled'; priority: number; assignedTo: string | null } | null
  findings: CaseFinding[]
  notifications: string[]
  outcome: string | null
  lastEventId: string | null
  /** Stream version of every event, by type, so a conflict can say what changed. */
  history: Array<{ version: number; type: string; eventId: string }>
}

export interface CaseEventLike {
  type: string
  payload: Record<string, unknown>
  streamVersion: number
  eventId: string
  occurredAt: string
}

export class DomainError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 409,
    readonly details?: unknown,
  ) {
    super(message)
  }
}

export const initialCase = (caseId: string): CaseState => ({
  caseId, version: 0, exists: false, caseType: null, tripId: null, symbol: null, carId: null, ownerMark: null, kind: null, position: null,
  tier: 0, status: 'open', owner: null, escalationLevel: 0, ackDueAt: null, routing: null, deskId: null, territoryId: null, yardId: null,
  deliveredAt: null, acknowledgedAt: null, acknowledgedBy: null, warnedYards: [], hold: null, workOrder: null, findings: [], notifications: [],
  outcome: null, lastEventId: null, history: [],
})

const str = (v: unknown) => (v === null || v === undefined ? null : String(v))
export const notificationKey = (channel: string, target: string, kind: string) => `${channel}|${target}|${kind}`

/** Applies one event. Never throws: events are facts that already happened. */
export function applyCaseEvent(s: CaseState, e: CaseEventLike): CaseState {
  const p = e.payload
  const next: CaseState = { ...s, version: e.streamVersion, lastEventId: e.eventId, history: [...s.history, { version: e.streamVersion, type: e.type, eventId: e.eventId }] }
  switch (e.type) {
    case 'AlertRaised':
      return {
        ...next, exists: true, caseType: 'alert', tripId: str(p.tripId), symbol: str(p.symbol), carId: str(p.carId), ownerMark: str(p.ownerMark),
        kind: str(p.kind), position: str(p.position), tier: Number(p.tier), status: 'open', owner: p.owner as Owner, ackDueAt: str(p.ackDueAt),
        routing: str(p.routing), deskId: str(p.deskId), territoryId: str(p.territoryId), yardId: str(p.yardId),
      }
    case 'AlertEscalated':
      return {
        ...next, tier: Number(p.toTier), owner: p.owner as Owner, ackDueAt: str(p.ackDueAt), escalationLevel: 0, routing: str(p.routing),
        deskId: str(p.deskId), territoryId: str(p.territoryId), yardId: str(p.yardId), status: p.reopened ? 'open' : s.status,
        workOrder: s.workOrder ? { ...s.workOrder, priority: Math.max(s.workOrder.priority, Number(p.toTier)) } : null,
      }
    case 'AlertHandedOff': {
      const to = p.to as Owner
      return {
        ...next, owner: to, ackDueAt: str(p.ackDueAt), escalationLevel: 0, status: s.status === 'acknowledged' ? 'open' : s.status,
        deskId: to.role === 'dispatcher' ? to.id : s.deskId, yardId: to.role === 'yard' ? to.id : s.yardId,
      }
    }
    case 'CarHoldMoved':
      return {
        ...next, yardId: str(p.toYardId),
        hold: s.hold ? { ...s.hold, yardId: String(p.toYardId) } : null,
        workOrder: s.workOrder ? { ...s.workOrder, yardId: String(p.toYardId) } : null,
      }
    case 'AlertAcknowledged':
      return { ...next, status: 'acknowledged', acknowledgedAt: e.occurredAt, acknowledgedBy: str(p.by) }
    case 'AckDeadlineMissed':
      return { ...next, escalationLevel: Number(p.toLevel), ackDueAt: str(p.nextAckDueAt) }
    case 'ApproachingYardWarned':
      return { ...next, escalationLevel: Math.max(s.escalationLevel, Number(p.toLevel)), warnedYards: [...s.warnedYards, String(p.yardId)] }
    case 'NotificationRequested':
      return { ...next, notifications: [...s.notifications, notificationKey(String(p.channel), String(p.target), String(p.kind))] }
    case 'NotificationDelivered':
      return { ...next, deliveredAt: p.channel === 'dispatcher' || p.channel === 'yard' ? (s.deliveredAt ?? e.occurredAt) : s.deliveredAt }
    case 'CarHoldPlaced':
      return { ...next, hold: { holdId: String(p.holdId), yardId: String(p.yardId), status: p.status as 'active' | 'bad_ordered' } }
    case 'CarHoldReleased':
      return { ...next, hold: s.hold ? { ...s.hold, status: 'released' } : null }
    case 'WorkOrderOpened':
      return {
        ...next,
        exists: true,
        caseType: s.caseType ?? (p.caseType as 'alert' | 'audit'),
        tripId: s.tripId ?? str(p.tripId),
        carId: s.carId ?? str(p.carId),
        kind: s.kind ?? str(p.kind),
        position: s.position ?? str(p.position),
        yardId: s.yardId ?? str(p.yardId),
        workOrder: { workOrderId: String(p.workOrderId), yardId: String(p.yardId), status: 'open', priority: Number(p.priority), assignedTo: null },
      }
    case 'WorkOrderStarted':
      return { ...next, workOrder: s.workOrder ? { ...s.workOrder, status: 'in_progress', assignedTo: str(p.by) } : null }
    case 'InspectionFindingRecorded': {
      const supersedes = str(p.supersedesFindingId)
      const findings = s.findings.map((f) => (f.findingId === supersedes ? { ...f, supersededBy: String(p.findingId) } : f))
      findings.push({
        findingId: String(p.findingId), clientSubmissionId: str(p.clientSubmissionId), finding: String(p.finding), disposition: String(p.disposition),
        source: String(p.source), supersededBy: null,
      })
      const badOrder = p.disposition === 'bad_order'
      return {
        ...next, findings, outcome: String(p.finding),
        status: s.caseType === 'alert' ? 'inspected' : s.status,
        hold: s.hold && badOrder ? { ...s.hold, status: 'bad_ordered' } : s.hold,
        workOrder: s.workOrder ? { ...s.workOrder, status: 'completed', assignedTo: s.workOrder.assignedTo ?? str(p.recordedBy) } : null,
      }
    }
    case 'CaseClosed':
      return {
        ...next, status: 'closed', outcome: str(p.outcome),
        workOrder: s.workOrder && s.workOrder.status !== 'completed' ? { ...s.workOrder, status: 'cancelled' } : s.workOrder,
      }
    default:
      return next
  }
}

export function foldCase(caseId: string, events: CaseEventLike[]): CaseState {
  return events.reduce(applyCaseEvent, initialCase(caseId))
}

/** A decided event, before it has a stream version. */
export type CaseEvent = NewEvent

const tagsFor = (s: CaseState, extra: Record<string, unknown> = {}) =>
  [`case:${s.caseId}`, ...(s.carId ?? extra.carId ? [`car:${s.carId ?? extra.carId}`] : []), ...(s.tripId ?? extra.tripId ? [`trip:${s.tripId ?? extra.tripId}`] : [])]

function ev(s: CaseState, type: string, payload: Record<string, unknown>, at: string | Date): CaseEvent {
  return { type, payload: { caseId: s.caseId, ...payload }, occurredAt: at, tags: tagsFor(s, payload) }
}

/** Applies decided events to the state (in memory), so a command can decide several steps in a row. */
export function evolve(s: CaseState, events: CaseEvent[]): CaseState {
  let state = s
  for (const e of events) {
    state = applyCaseEvent(state, {
      type: e.type, payload: e.payload, streamVersion: state.version + 1, eventId: e.eventId ?? `pending-${state.version + 1}`, occurredAt: new Date(e.occurredAt).toISOString(),
    })
  }
  return state
}

// ── Commands from the analyzer ──────────────────────────────────────────────

export interface RaiseInput {
  tripId: string
  symbol: string
  carId: string
  ownerMark: string | null
  kind: string
  position: string
  tier: number
  action: string
  routing: string
  deskId: string | null
  territoryId: string | null
  yardId: string | null
  owner: Owner
  ackDueAt: Date | null
  reasons: string[]
  features: Record<string, unknown>
  routeNote: string
  trigger: { detectorId: string; passId: string; passedAt: string; lagSeconds: number }
  late: boolean
  at: Date
}

export function decideRaise(s: CaseState, i: RaiseInput): CaseEvent[] {
  if (s.exists) throw new DomainError('CASE_EXISTS', `case ${s.caseId} already exists`)
  const { at, ackDueAt, ...rest } = i
  return [ev({ ...s, carId: i.carId, tripId: i.tripId }, 'AlertRaised', { ...rest, ackDueAt: ackDueAt?.toISOString() ?? null }, at)]
}

export interface EscalateInput extends Omit<RaiseInput, 'tripId' | 'symbol' | 'carId' | 'ownerMark' | 'kind' | 'position'> {
  reopened: boolean
}

export function decideEscalate(s: CaseState, i: EscalateInput): CaseEvent[] {
  if (!s.exists || s.caseType !== 'alert') throw new DomainError('NO_ALERT', 'not an alert case')
  if (s.status === 'closed' || s.status === 'inspected') return []
  if (i.tier <= s.tier) return []
  const { at, ackDueAt, tier, ...rest } = i
  // The hold stays at the yard it was placed for; a yard only appears if none was set.
  return [ev(s, 'AlertEscalated', { ...rest, fromTier: s.tier, toTier: tier, yardId: s.yardId ?? i.yardId, ackDueAt: ackDueAt?.toISOString() ?? null }, at)]
}

export function decidePlaceHold(s: CaseState, yardId: string, reason: string, at: Date): CaseEvent[] {
  if (s.hold || s.status === 'closed' || !s.carId) return []
  return [ev(s, 'CarHoldPlaced', { holdId: randomUUID(), carId: s.carId, yardId, reason, status: 'active' }, at)]
}

export function decideOpenWorkOrder(s: CaseState, i: { caseType: 'alert' | 'audit'; tripId: string | null; carId: string; position: string; kind: string; yardId: string; priority: number; at: Date | string }): CaseEvent[] {
  if (s.workOrder) return []
  const { at, ...rest } = i
  return [ev({ ...s, carId: i.carId, tripId: i.tripId }, 'WorkOrderOpened', { workOrderId: randomUUID(), ...rest }, at)]
}

export function decideNotify(s: CaseState, n: { channel: string; target: string; kind: string; message: string; at: Date }): CaseEvent[] {
  if (s.notifications.includes(notificationKey(n.channel, n.target, n.kind))) return []
  return [ev(s, 'NotificationRequested', { notificationId: randomUUID(), channel: n.channel, target: n.target, kind: n.kind, message: n.message }, n.at)]
}

export function decideClose(s: CaseState, i: { reason: 'released' | 'repaired' | 'component_replaced' | 'identity_corrected' | 'audit_complete'; outcome: string; note: string; by: string; at: Date }): CaseEvent[] {
  if (!s.exists || s.status === 'closed') return []
  const out: CaseEvent[] = []
  if (s.hold && s.hold.status !== 'released') out.push(ev(s, 'CarHoldReleased', { holdId: s.hold.holdId, carId: s.carId, yardId: s.hold.yardId, by: i.by, reason: i.reason }, i.at))
  out.push(ev(s, 'CaseClosed', { outcome: i.outcome, reason: i.reason, note: i.note, closedBy: i.by }, i.at))
  return out
}

// ── Commands from the process manager ───────────────────────────────────────

export function decideHandOff(s: CaseState, to: Owner, reason: 'desk_territory' | 'passed_yard', ackDueAt: Date | null, note: string, at: Date): CaseEvent[] {
  if (!s.owner || s.status === 'closed' || s.status === 'inspected') return []
  if (s.owner.role !== to.role || to.id === null || s.owner.id === to.id) return []
  return [ev(s, 'AlertHandedOff', { from: s.owner, to, reason, ackDueAt: ackDueAt?.toISOString() ?? null, note }, at)]
}

export function decideMoveHold(s: CaseState, toYardId: string, note: string, at: Date): CaseEvent[] {
  if (!s.hold || s.hold.status !== 'active' || s.hold.yardId === toYardId || s.status === 'closed') return []
  if (!s.workOrder || (s.workOrder.status !== 'open' && s.workOrder.status !== 'in_progress')) return []
  return [ev(s, 'CarHoldMoved', { holdId: s.hold.holdId, carId: s.carId, fromYardId: s.hold.yardId, toYardId, workOrderId: s.workOrder.workOrderId, note }, at)]
}

// ── Commands from people ────────────────────────────────────────────────────

export interface Actor {
  username: string
  role: 'dispatcher' | 'yard' | 'admin'
  yardId: string | null
}

export function isOwner(s: CaseState, a: Actor): boolean {
  if (!s.owner || s.owner.role === 'owner') return false
  if (a.role === 'admin') return true
  if (a.role === 'dispatcher') return s.owner.role === 'dispatcher'
  return a.role === 'yard' && s.owner.role === 'yard' && s.owner.id === a.yardId
}

/**
 * Concurrent case updates. The console sends the case version it was looking at.
 * Events appended since then are classified, never ignored:
 *  - only notifications, deliveries, holds or deadline bookkeeping: the person's view of the
 *    decision is still right, so the command is rebased onto the current version;
 *  - a decision (tier, owner, status, finding) changed: refused with 409 and the current case,
 *    so a person reviews it. This replaces last-write-wins.
 */
export function interveningDecisions(s: CaseState, seenVersion: number): string[] {
  return s.history.filter((h) => h.version > seenVersion && DECISION_EVENTS.has(h.type)).map((h) => h.type)
}

export function decideAcknowledge(s: CaseState, i: { actor: Actor; seenVersion: number; action: string; note: string | null; at: Date }): CaseEvent[] {
  if (!s.exists || s.caseType !== 'alert') throw new DomainError('NOT_FOUND', 'Alert not found', 404)
  if (!isOwner(s, i.actor)) throw new DomainError('NOT_OWNER', `This alert is owned by the ${s.owner?.role ?? 'unknown'} ${s.owner?.id ?? ''}`.trim(), 403)
  const changed = interveningDecisions(s, i.seenVersion)
  if (changed.length > 0 || s.status !== 'open') {
    throw new DomainError('STALE_ALERT', 'The alert changed (escalated, handed off or acknowledged by someone else). Review it and try again.', 409, { changed })
  }
  return [ev(s, 'AlertAcknowledged', { by: i.actor.username, action: i.action, note: i.note, tier: s.tier, via: 'console' }, i.at)]
}

export function decideStartWorkOrder(s: CaseState, i: { actor: Actor; at: Date }): CaseEvent[] {
  if (!s.workOrder) throw new DomainError('NOT_FOUND', 'Work order not found', 404)
  if (i.actor.role !== 'admin' && i.actor.yardId !== s.workOrder.yardId) throw new DomainError('FORBIDDEN', 'This work order belongs to another yard', 403)
  if (s.workOrder.status !== 'open') throw new DomainError('NOT_OPEN', 'Work order is not open')
  const out = [ev(s, 'WorkOrderStarted', { workOrderId: s.workOrder.workOrderId, by: i.actor.username }, i.at)]
  // Starting the inspection is the yard's acknowledgment: a person now owns it.
  if (s.caseType === 'alert' && s.status === 'open' && s.owner?.role === 'yard') {
    out.push(ev(s, 'AlertAcknowledged', { by: i.actor.username, action: 'inspection_started', note: 'Inspection started', tier: s.tier, via: 'inspection_started' }, i.at))
  }
  return out
}

export interface FindingInput {
  clientSubmissionId: string
  finding: string
  disposition: string
  notes: string | null
  observedAt: string
  replacement: { componentId: string; installedAt: string; axle: number } | null
}

export type FindingDecision =
  | { kind: 'recorded'; events: CaseEvent[]; findingId: string }
  | { kind: 'replayed'; findingId: string }
  | { kind: 'equivalent'; findingId: string }

const SEVERITY: Record<string, number> = { no_defect_found: 0, wheel_defect: 1, brake_defect: 1, confirmed_bearing_defect: 2 }
const isDefect = (finding: string) => finding !== 'no_defect_found'

/**
 * Two offline tablets can inspect the same car and sync later. Each submission carries its own
 * id; the second one finds the work order already completed. Domain rule, not last-write-wins:
 *  - same submission id: a replay; return the stored finding;
 *  - the stored finding reports a defect: the later report is refused (a defect is never erased);
 *  - the stored finding is "no defect" and the later one reports a defect: the defect supersedes
 *    it, the car is held again and the case goes back to inspected;
 *  - both "no defect": equivalent; the stored one stands.
 */
export function decideRecordFinding(s: CaseState, i: { actor: Actor; input: FindingInput; at: Date }): FindingDecision {
  const prior = s.findings.find((f) => f.clientSubmissionId === i.input.clientSubmissionId)
  if (prior) return { kind: 'replayed', findingId: prior.findingId }
  if (!s.workOrder || !s.carId) throw new DomainError('NOT_FOUND', 'Work order not found', 404)
  if (i.actor.role !== 'admin' && i.actor.yardId !== s.workOrder.yardId) throw new DomainError('FORBIDDEN', 'This work order belongs to another yard', 403)
  if (s.workOrder.status === 'cancelled') throw new DomainError('ALREADY_COMPLETED', 'Work order is already cancelled')
  const findingId = randomUUID()
  const source = s.caseType === 'alert' ? 'alert' : 'audit'
  const base = {
    findingId, workOrderId: s.workOrder.workOrderId, clientSubmissionId: i.input.clientSubmissionId, carId: s.carId, position: s.position ?? 'ALL',
    finding: i.input.finding, disposition: i.input.disposition, notes: i.input.notes, recordedBy: i.actor.username, observedAt: i.input.observedAt,
    replacement: i.input.replacement, source,
  }
  const current = s.findings.find((f) => f.supersededBy === null)
  if (s.workOrder.status === 'completed' && current) {
    if (isDefect(current.finding)) {
      throw new DomainError('FINDING_CONFLICT', 'Another inspection already recorded a defect for this car; a defect report is never overwritten', 409, { finding: current })
    }
    if (!isDefect(i.input.finding)) return { kind: 'equivalent', findingId: current.findingId }
    // A defect reported after a "no defect": the more severe finding wins.
    const events: CaseEvent[] = [ev(s, 'InspectionFindingRecorded', { ...base, supersedesFindingId: current.findingId }, i.at)]
    let after = evolve(s, events)
    if (i.input.disposition === 'bad_order' && s.hold) {
      events.push(ev(after, 'CarHoldPlaced', { holdId: randomUUID(), carId: s.carId, yardId: s.workOrder.yardId, reason: `Superseding finding from another tablet: ${i.input.finding.replace(/_/g, ' ')}`, status: 'bad_ordered' }, i.at))
      after = evolve(after, events.slice(-1))
    }
    if (i.input.disposition !== 'bad_order' || s.caseType === 'audit') events.push(...closeAfterFinding(after, i.input, i.actor.username, i.at))
    return { kind: 'recorded', events, findingId }
  }
  if (SEVERITY[i.input.finding] === undefined) throw new DomainError('VALIDATION_FAILED', 'Unknown finding', 422)
  const events: CaseEvent[] = [ev(s, 'InspectionFindingRecorded', { ...base, supersedesFindingId: null }, i.at)]
  const after = evolve(s, events)
  // Inspected is not closed: a bad-ordered car's alert stays inspected until the repair is recorded.
  if (i.input.disposition !== 'bad_order' || s.caseType === 'audit') events.push(...closeAfterFinding(after, i.input, i.actor.username, i.at))
  return { kind: 'recorded', events, findingId }
}

function closeAfterFinding(s: CaseState, input: FindingInput, by: string, at: Date): CaseEvent[] {
  if (s.caseType === 'audit') {
    return decideClose(s, { reason: 'audit_complete', outcome: input.finding, note: `Audit: ${input.finding.replace(/_/g, ' ')}`, by, at })
  }
  const repaired = input.disposition === 'repaired'
  return decideClose(s, {
    reason: repaired ? 'repaired' : 'released',
    outcome: input.finding,
    note: repaired ? 'Repaired on the spot and released' : 'Released to service',
    by,
    at,
  })
}
