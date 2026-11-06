/**
 * Commands from people: acknowledge an alert, start an inspection, record a
 * finding, record a wheelset install. Each loads the aggregate from its stream,
 * decides with the pure rules in domain/, and appends with the loaded version
 * as the expected version. A concurrent append makes the whole command re-run
 * against the new state (withEventTransaction), where the domain rule decides:
 * rebase, refuse with 409, or (two tablets) the more severe finding wins.
 *
 * Responses are built from the aggregate, not from the projections, so the
 * caller sees its own write even before the projector has applied it.
 * @module api/services/commands
 */
import { z } from 'zod'
import type { SessionUser } from '../../shared/auth.js'
import { now } from '../../shared/clock.js'
import { DISPOSITIONS, FINDINGS } from '../../shared/domain.js'
import { HttpError } from '../../shared/errors.js'
import { newCorrelationId, withEventTransaction } from '../../events/store.js'
import { decideAcknowledge, decideRecordFinding, decideStartWorkOrder, DomainError, type Actor, type CaseState } from '../../domain/case.js'
import { decideReplaceComponent } from '../../domain/car.js'
import { caseIdForWorkOrder, loadCar, loadCase, stageCar, stageCase, syncCaseIndex } from '../../domain/repository.js'

const isoDate = z.string().datetime({ offset: true })

export const ackSchema = z.object({
  version: z.number().int().min(1),
  action: z.enum(['stop_ordered', 'setout_planned', 'restricted_speed', 'inspect_at_terminal', 'brake_inspection', 'monitor', 'will_inspect_on_arrival']),
  note: z.string().max(500).optional(),
})

export const replacementSchema = z.object({
  componentId: z.string().min(3).max(40),
  installedAt: isoDate,
  axle: z.number().int().min(1).max(12).optional(),
})

export const findingSchema = z
  .object({
    clientSubmissionId: z.string().min(8).max(100),
    finding: z.enum(FINDINGS),
    disposition: z.enum(DISPOSITIONS),
    notes: z.string().max(1000).optional(),
    observedAt: isoDate.optional(),
    replacement: replacementSchema.optional(),
  })
  .refine((f) => f.finding === 'no_defect_found' || f.disposition !== 'release', {
    message: 'A car with a confirmed defect must be bad-ordered or repaired, not released',
    path: ['disposition'],
  })
  .refine((f) => f.disposition !== 'repaired' || f.replacement !== undefined, {
    message: 'A repair must record the replacement wheelset (component id and install time)',
    path: ['replacement'],
  })

export const installSchema = z.object({
  clientSubmissionId: z.string().min(8).max(100),
  axle: z.number().int().min(1).max(12),
  componentId: z.string().min(3).max(40),
  installedAt: isoDate,
})

const actorOf = (u: SessionUser): Actor => ({ username: u.username, role: u.role, yardId: u.yardId })

/** Domain errors become HTTP errors with the current state attached where useful. */
function toHttp(err: unknown, details?: unknown): never {
  if (err instanceof DomainError) throw new HttpError(err.status, err.code, err.message, details ?? err.details)
  throw err
}

export async function acknowledge(caseId: string, body: z.infer<typeof ackSchema>, user: SessionUser): Promise<{ state: CaseState; rebasedOver: number }> {
  let rebasedOver = 0
  try {
    const { result } = await withEventTransaction({ correlationId: `ack:${newCorrelationId()}`, actor: user.username }, async ({ client, batch }) => {
      const s = await loadCase(client, caseId)
      if (!s.exists) throw new DomainError('NOT_FOUND', 'Alert not found', 404)
      // Caused by the newest event the person had seen, so the timeline shows what they were answering.
      const seen = s.history.find((h) => h.version === body.version)?.eventId ?? s.lastEventId
      const events = decideAcknowledge(s, { actor: actorOf(user), seenVersion: body.version, action: body.action, note: body.note ?? null, at: now() }).map((e) => ({ ...e, causationId: seen }))
      rebasedOver = s.version - body.version
      const after = stageCase(batch, s, events)
      await syncCaseIndex(client, after)
      return after
    })
    return { state: result, rebasedOver }
  } catch (err) {
    if (err instanceof DomainError && err.code === 'STALE_ALERT') {
      const { getAlertRow } = await import('./queries.js')
      throw new HttpError(409, 'STALE_ALERT', err.message, { alert: await getAlertRow(caseId), ...(err.details as object) })
    }
    return toHttp(err)
  }
}

export async function startWorkOrder(workOrderId: string, user: SessionUser): Promise<CaseState> {
  try {
    const { result } = await withEventTransaction({ correlationId: `inspection:${workOrderId}`, actor: user.username }, async ({ client, batch }) => {
      const caseId = await caseIdForWorkOrder(client, workOrderId)
      if (!caseId) throw new DomainError('NOT_FOUND', 'Work order not found', 404)
      const s = await loadCase(client, caseId)
      const after = stageCase(batch, s, decideStartWorkOrder(s, { actor: actorOf(user), at: now() }))
      await syncCaseIndex(client, after)
      return after
    })
    return result
  } catch (err) {
    return toHttp(err)
  }
}

export interface FindingResult {
  findingId: string
  replayed: boolean
  superseded: boolean
  state: CaseState
}

export async function recordFinding(workOrderId: string, input: z.infer<typeof findingSchema>, user: SessionUser): Promise<FindingResult> {
  const replacement = input.replacement
    ? { componentId: input.replacement.componentId, installedAt: input.replacement.installedAt, axle: input.replacement.axle ?? 0 }
    : null
  try {
    const { result } = await withEventTransaction({ correlationId: `finding:${input.clientSubmissionId}`, actor: user.username }, async ({ client, batch }) => {
      const caseId = await caseIdForWorkOrder(client, workOrderId)
      if (!caseId) throw new DomainError('NOT_FOUND', 'Work order not found', 404)
      const s = await loadCase(client, caseId)
      if (replacement && replacement.axle === 0) {
        if (!/^[LR]\d$/.test(s.position ?? '')) throw new DomainError('AXLE_REQUIRED', 'Say which axle the replacement wheelset went on', 422)
        replacement.axle = Number(s.position!.slice(1))
      }
      const decision = decideRecordFinding(s, {
        actor: actorOf(user),
        input: { clientSubmissionId: input.clientSubmissionId, finding: input.finding, disposition: input.disposition, notes: input.notes ?? null, observedAt: input.observedAt ?? now().toISOString(), replacement },
        at: now(),
      })
      if (decision.kind !== 'recorded') return { findingId: decision.findingId, replayed: true, superseded: false, state: s }
      // The finding is the cause of whatever follows it (hold released or re-placed, case closed).
      const [first, ...rest] = decision.events
      const recorded = stageCase(batch, s, [first])
      const after = stageCase(batch, recorded, rest.map((e) => ({ ...e, causationId: recorded.lastEventId })))
      await syncCaseIndex(client, after)
      const superseded = decision.events.some((e) => e.type === 'InspectionFindingRecorded' && (e.payload as { supersedesFindingId: string | null }).supersedesFindingId !== null)
      return { findingId: decision.findingId, replayed: false, superseded, state: after }
    })
    return result
  } catch (err) {
    if (err instanceof Error && 'constraint' in err && (err as { constraint?: string }).constraint === 'case_index_one_open_alert') {
      throw new HttpError(409, 'FINDING_CONFLICT', 'A newer alert for this bearing is already open; record the finding against it')
    }
    return toHttp(err)
  }
}

export async function recordInstall(carId: string, input: z.infer<typeof installSchema>, user: SessionUser): Promise<{ eventId: string; replayed: boolean; version: number }> {
  try {
    const { result, events } = await withEventTransaction({ correlationId: `install:${input.clientSubmissionId}`, actor: user.username }, async ({ client, batch }) => {
      const car = await loadCar(client, carId)
      const decision = decideReplaceComponent(car, {
        axle: input.axle, componentId: input.componentId, installedAt: input.installedAt, recordedBy: user.username, findingId: null, caseId: null,
        clientSubmissionId: input.clientSubmissionId,
      })
      if (decision.kind === 'replayed') return { eventId: decision.eventId, replayed: true, version: car.version }
      stageCar(batch, car, decision.events)
      return { eventId: '', replayed: false, version: car.version + 1 }
    })
    return result.replayed ? result : { ...result, eventId: events[0]?.eventId ?? '' }
  } catch (err) {
    return toHttp(err)
  }
}
