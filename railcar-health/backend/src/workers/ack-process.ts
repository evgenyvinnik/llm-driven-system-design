/**
 * The acknowledgment process manager: the one orchestrated flow.
 *
 * Choreography handles "when X happens, do Y" well. "If nobody acknowledges
 * within 15 minutes, page the chief dispatcher; if still nobody after 15 more,
 * the operations center; warn the yard 30 minutes before the train gets there;
 * and when the train crosses into the East desk's territory, start over with
 * East" needs memory and time. So one component owns it:
 *
 *  - It listens to case events and trip positions, and keeps DURABLE TIMERS in
 *    ack_timers (due_at in domain time), one per case and kind.
 *  - A poller claims due timers with FOR UPDATE SKIP LOCKED (several workers
 *    never fire the same timer; a crash mid-fire leaves it pending), re-loads the
 *    case from its stream and decides with the pure rules in analyzer/ownership.
 *  - Its commands are events on the case stream (AckDeadlineMissed,
 *    ApproachingYardWarned, AlertHandedOff, CarHoldMoved, NotificationRequested),
 *    appended with the loaded version as the expected version. If the dispatcher
 *    acknowledged a millisecond earlier, the append conflicts, the case is
 *    re-read, and the escalation no longer applies. There is no compensation to
 *    run because nothing was done that must be undone: a timer that loses the
 *    race simply finds nothing to do.
 * @module workers/ack-process
 */
import type pg from 'pg'
import { config } from '../shared/config.js'
import { nowMs } from '../shared/clock.js'
import { pool, type Queryable } from '../shared/db.js'
import { ACK_DEADLINE_MINUTES, TIER_NAMES } from '../shared/domain.js'
import { publishEvents, type LiveEvent } from '../shared/events.js'
import { logger } from '../shared/logger.js'
import { ackEscalations, timersFired } from '../shared/metrics.js'
import type { Handler } from '../events/consumer.js'
import { withEventTransaction, type EventBatch } from '../events/store.js'
import { decideHandOff, decideMoveHold, decideNotify, evolve, type CaseEvent, type CaseState } from '../domain/case.js'
import { loadCase, loadCases, openCaseIds, stageCase, syncCaseIndex } from '../domain/repository.js'
import { ackDeadline, decideEscalation, escalationLabel } from '../analyzer/ownership.js'
import { kindLabel } from '../analyzer/alert-manager.js'

const owned = (s: CaseState) => s.exists && s.caseType === 'alert' && s.owner !== null && (s.owner.role === 'dispatcher' || s.owner.role === 'yard')

/** Brings the case's acknowledgment timer in line with its current state (idempotent). */
export async function scheduleAckTimer(db: Queryable, s: CaseState): Promise<void> {
  if (owned(s) && s.status === 'open' && s.ackDueAt) {
    await db.query(
      `INSERT INTO ack_timers (case_id, kind, due_at, status, level, case_version, updated_at) VALUES ($1, 'ack_deadline', $2, 'pending', $3, $4, now())
       ON CONFLICT (case_id, kind) DO UPDATE SET due_at = EXCLUDED.due_at, status = 'pending', level = EXCLUDED.level, case_version = EXCLUDED.case_version, updated_at = now()
       WHERE ack_timers.case_version <= EXCLUDED.case_version`,
      [s.caseId, s.ackDueAt, s.escalationLevel, s.version],
    )
  } else {
    await db.query(`UPDATE ack_timers SET status = 'cancelled', updated_at = now() WHERE case_id = $1 AND status = 'pending' AND (kind = 'ack_deadline' OR $2)`, [s.caseId, s.status !== 'open'])
  }
}

async function scheduleApproachTimer(db: Queryable, s: CaseState, nextYardId: string | null, etaIso: string | null): Promise<void> {
  if (!owned(s) || s.status !== 'open' || !s.deliveredAt || !s.yardId || s.yardId !== nextYardId || !etaIso || s.warnedYards.includes(s.yardId)) return
  const due = Math.max(nowMs(), new Date(etaIso).getTime() - config.analysis.approachWindowMinutes * 60_000)
  await db.query(
    `INSERT INTO ack_timers (case_id, kind, due_at, status, level, case_version, note, updated_at) VALUES ($1, 'approach_yard', $2, 'pending', $3, $4, $5, now())
     ON CONFLICT (case_id, kind) DO UPDATE SET due_at = EXCLUDED.due_at, case_version = EXCLUDED.case_version, note = EXCLUDED.note, updated_at = now()
     WHERE ack_timers.status = 'pending'`,
    [s.caseId, new Date(due), s.escalationLevel, s.version, `${s.yardId}|${etaIso}`],
  )
}

/** Handoffs and hold moves as the train travels (TripPositionUpdated). */
function decideMoves(s: CaseState, pos: { deskId: string | null; nextYardId: string | null; status: string; symbol: string }, at: Date): CaseEvent[] {
  if (!owned(s) || pos.status !== 'en_route' || s.status === 'inspected' || s.status === 'closed') return []
  const out: CaseEvent[] = []
  let state = s
  const label = `${TIER_NAMES[s.tier]} ${kindLabel(s.kind ?? '')} ${s.carId} on ${pos.symbol}`
  // The hold and work order follow the train to the next yard, whoever owns the alert.
  if (pos.nextYardId && s.hold?.yardId && s.hold.yardId !== pos.nextYardId) {
    const from = s.hold.yardId
    const moved = decideMoveHold(state, pos.nextYardId, `Car went past ${from} uninspected: hold and work order moved to ${pos.nextYardId}`, at)
    if (moved.length > 0) {
      out.push(...moved)
      state = evolve(state, moved)
      if (state.owner?.role === 'yard') {
        const note = `Car went past ${from} uninspected: hold and work order handed to ${pos.nextYardId}, which must acknowledge`
        const hand = decideHandOff(state, { role: 'yard', id: pos.nextYardId }, 'passed_yard', ackDeadline(state.tier, 'yard', at.getTime()), note, at)
        out.push(...hand)
        state = evolve(state, hand)
        const n = decideNotify(state, { channel: 'yard', target: pos.nextYardId, kind: 'handoff', message: `${label}: ${note}`, at })
        out.push(...n)
        state = evolve(state, n)
      } else {
        const n = decideNotify(state, { channel: 'yard', target: pos.nextYardId, kind: 'rerouted', message: `${label}: car held for inspection at ${pos.nextYardId} (went past ${from})`, at })
        out.push(...n)
        state = evolve(state, n)
      }
    }
  }
  // A dispatcher-owned alert moves to the desk whose territory the train entered.
  if (state.owner?.role === 'dispatcher' && pos.deskId && state.owner.id !== pos.deskId) {
    const from = state.owner.id
    const note = `Train left ${from} desk territory: ownership handed to ${pos.deskId} desk, which must acknowledge`
    const hand = decideHandOff(state, { role: 'dispatcher', id: pos.deskId }, 'desk_territory', ackDeadline(state.tier, 'dispatcher', at.getTime()), note, at)
    out.push(...hand)
    state = evolve(state, hand)
    out.push(...decideNotify(state, { channel: 'dispatcher', target: pos.deskId, kind: 'handoff', message: `${label}: ${note}`, at }))
  }
  return out
}

export const ackProcessHandler: Handler = async (event, { client, batch }) => {
  const p = event.payload as Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
  if (event.type === 'TripPositionUpdated') {
    const at = new Date(nowMs())
    const notices: LiveEvent[] = []
    for (const s of await loadCases(client, await openCaseIds(client, { tripId: p.tripId }))) {
      const events = decideMoves(s, { deskId: p.deskId, nextYardId: p.nextYardId, status: p.status, symbol: p.symbol }, at)
      const after = stageCase(batch, s, events)
      if (events.length > 0) {
        await syncCaseIndex(client, after)
        await scheduleAckTimer(client, after)
        notices.push({ type: 'alert.updated', alertId: s.caseId, tripId: p.tripId, yardId: after.yardId })
      }
      await scheduleApproachTimer(client, after, p.nextYardId, p.nextYardEta)
    }
    return { notices }
  }
  // Every other handled event is about one case: re-read it and align its timers with its current state.
  const s = await loadCase(client, String(p.caseId))
  await scheduleAckTimer(client, s)
  return undefined
}

interface TimerRow {
  case_id: string
  kind: 'ack_deadline' | 'approach_yard'
  due_at: Date
  level: number
  note: string | null
}

/** Fires one due timer, if any. Returns false when nothing is due. */
export async function fireNextTimer(): Promise<boolean> {
  const now = nowMs()
  const { result } = await withEventTransaction({ correlationId: 'timer', actor: 'ack-process' }, async ({ client, batch }) => {
    const { rows } = await client.query<TimerRow>(
      `SELECT case_id, kind, due_at, level, note FROM ack_timers WHERE status = 'pending' AND due_at <= $1
        ORDER BY due_at LIMIT 1 FOR UPDATE SKIP LOCKED`,
      [new Date(now)],
    )
    const timer = rows[0]
    if (!timer) return null
    const s = await loadCase(client, timer.case_id)
    const outcome = await decideTimer(client, batch, timer, s, now)
    timersFired.inc({ kind: timer.kind, result: outcome.result })
    return { timer, ...outcome, caseId: s.caseId, tripId: s.tripId, yardId: s.yardId }
  })
  if (!result) return false
  if (result.result === 'escalated') {
    logger.info({ caseId: result.caseId, kind: result.timer.kind, note: result.note }, 'timer fired: escalated')
    await publishEvents([{ type: 'alert.updated', alertId: result.caseId, tripId: result.tripId ?? undefined, yardId: result.yardId }])
  }
  return true
}

async function decideTimer(client: pg.PoolClient, batch: EventBatch, timer: TimerRow, s: CaseState, now: number): Promise<{ result: 'escalated' | 'stale' | 'postponed'; note?: string }> {
  const done = async (status: 'fired' | 'cancelled') =>
    client.query(`UPDATE ack_timers SET status = $3, fired_at = now(), attempts = attempts + 1, updated_at = now() WHERE case_id = $1 AND kind = $2`, [timer.case_id, timer.kind, status])
  if (!owned(s) || s.status !== 'open') {
    await done('cancelled')
    return { result: 'stale' }
  }
  // Delivered is not acknowledged, but an undelivered page can't be blamed on the owner yet.
  if (!s.deliveredAt) {
    await client.query(`UPDATE ack_timers SET due_at = $3, attempts = attempts + 1, updated_at = now() WHERE case_id = $1 AND kind = $2`, [timer.case_id, timer.kind, new Date(now + 60_000)])
    return { result: 'postponed' }
  }
  const role = s.owner!.role as 'dispatcher' | 'yard'
  const trip = (await client.query<{ symbol: string; next_yard_id: string | null; next_yard_eta: Date | null }>('SELECT symbol, next_yard_id, next_yard_eta FROM trips WHERE trip_id = $1', [s.tripId])).rows[0]
  const headingToYard = timer.kind === 'approach_yard' && s.yardId !== null && trip?.next_yard_id === s.yardId && trip.next_yard_eta !== null
  const decision = decideEscalation({
    status: s.status,
    role,
    level: s.escalationLevel,
    ackDueAtMs: timer.kind === 'ack_deadline' && s.ackDueAt ? new Date(s.ackDueAt).getTime() : null,
    nowMs: now,
    yardEtaMs: headingToYard ? trip!.next_yard_eta!.getTime() : null,
    approachWindowMinutes: config.analysis.approachWindowMinutes,
    alreadyWarnedYard: s.yardId !== null && s.warnedYards.includes(s.yardId),
  })
  if (!decision.escalate) {
    await done(timer.kind === 'ack_deadline' && s.ackDueAt && new Date(s.ackDueAt).getTime() > now ? 'cancelled' : 'fired')
    return { result: 'stale' }
  }
  const at = new Date(now)
  const minutes = ACK_DEADLINE_MINUTES[s.tier] ?? 60
  const label = escalationLabel(role, decision.toLevel)
  const symbol = trip?.symbol ?? s.symbol ?? ''
  const target = decision.reason === 'approaching_yard' ? `yard-supervisor:${s.yardId}` : decision.toLevel >= 2 ? 'operations-center' : `${role === 'dispatcher' ? 'chief-dispatcher' : 'yard-supervisor'}:${s.owner!.id}`
  let events: CaseEvent[]
  let note: string
  if (decision.reason === 'ack_overdue') {
    note = `No acknowledgment from ${escalationLabel(role, s.escalationLevel)} ${s.owner!.id ?? ''} within ${minutes} min: escalated to ${label}`
    const next = new Date(now + minutes * 60_000)
    events = [{
      type: 'AckDeadlineMissed', occurredAt: at, tags: [`case:${s.caseId}`, `car:${s.carId}`, `trip:${s.tripId}`],
      payload: { caseId: s.caseId, ownerRole: role, ownerId: s.owner!.id, fromLevel: s.escalationLevel, toLevel: decision.toLevel, escalatedTo: label, nextAckDueAt: next.toISOString(), note },
    }]
  } else {
    note = `Delivered but unacknowledged and ${symbol} is due at ${s.yardId} within ${config.analysis.approachWindowMinutes} min: ${s.yardId} supervisor warned so the car is caught`
    events = [{
      type: 'ApproachingYardWarned', occurredAt: at, tags: [`case:${s.caseId}`, `car:${s.carId}`, `trip:${s.tripId}`],
      payload: { caseId: s.caseId, yardId: s.yardId, etaAt: trip!.next_yard_eta!.toISOString(), toLevel: decision.toLevel, note },
    }]
  }
  let after = stageCase(batch, s, events)
  const cause = after.lastEventId
  after = stageCase(batch, after, decideNotify(after, {
    channel: decision.toLevel >= 2 ? 'operations' : 'supervisor', target, kind: `${decision.reason}:${decision.toLevel}`, message: `${TIER_NAMES[s.tier]} ${s.carId} on ${symbol}: ${note}`, at,
  }).map((e) => ({ ...e, causationId: cause })))
  await syncCaseIndex(client, after)
  if (timer.kind === 'ack_deadline') await scheduleAckTimer(client, after)
  else await done('fired')
  ackEscalations.inc({ reason: decision.reason })
  return { result: 'escalated', note }
}

/** Polls the durable timers until stopped. */
export function startTimerPoller(): () => void {
  let stopped = false
  const loop = async () => {
    while (!stopped) {
      try {
        while (!stopped && (await fireNextTimer())) {
          // drain everything that is due
        }
      } catch (err) {
        logger.warn({ err: (err as Error).message }, 'timer poll failed')
      }
      await new Promise((r) => setTimeout(r, config.analysis.timerPollMs))
    }
  }
  void loop()
  return () => {
    stopped = true
  }
}

export async function timerStats(db: Queryable = pool): Promise<{ pending: number; overdue: number; fired: number }> {
  const { rows } = await db.query<{ pending: number; overdue: number; fired: number }>(
    `SELECT count(*) FILTER (WHERE status = 'pending')::int AS pending,
            count(*) FILTER (WHERE status = 'pending' AND due_at <= $1)::int AS overdue,
            count(*) FILTER (WHERE status = 'fired')::int AS fired
       FROM ack_timers`,
    [new Date(nowMs())],
  )
  return rows[0]
}
