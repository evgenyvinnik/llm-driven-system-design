/**
 * The car aggregate: a railcar's component history. A car outlives its
 * wheelsets (an axle, two wheels and two journal bearings), so the component on
 * an axle at any instant is rebuilt from ComponentReplaced events, each with an
 * event time (installedAt) and a processing time (recordedAt). Stand-alone
 * findings (routine inspections, bearing-shop teardowns) also live here.
 *
 * Invariants: one current wheelset per axle; an install older than the current
 * one on that axle is refused (it would rewrite history); a tablet submission
 * is applied once.
 * @module domain/car
 */
import { randomUUID } from 'node:crypto'
import type { NewEvent } from '../events/store.js'
import { DomainError, type CaseEventLike } from './case.js'

export interface AxleInstall {
  axle: number
  componentId: string
  installedAtMs: number
  removedAtMs: number | null
  recordedAt: string
}

export interface CarState {
  carId: string
  version: number
  installs: AxleInstall[]
  submissions: Record<string, string>
  findingIds: string[]
}

export const initialCar = (carId: string): CarState => ({ carId, version: 0, installs: [], submissions: {}, findingIds: [] })

export function applyCarEvent(s: CarState, e: CaseEventLike & { recordedAt?: string }): CarState {
  const p = e.payload
  if (e.type === 'ComponentReplaced') {
    const axle = Number(p.axle)
    const at = new Date(String(p.installedAt)).getTime()
    const installs = s.installs.map((i) => (i.axle === axle && i.removedAtMs === null && i.installedAtMs < at ? { ...i, removedAtMs: at } : i))
    installs.push({ axle, componentId: String(p.installedComponentId), installedAtMs: at, removedAtMs: null, recordedAt: e.recordedAt ?? e.occurredAt })
    const submissions = { ...s.submissions }
    if (p.clientSubmissionId) submissions[String(p.clientSubmissionId)] = e.eventId
    if (p.findingId) submissions[`finding:${p.findingId}`] = e.eventId
    return { ...s, version: e.streamVersion, installs, submissions }
  }
  if (e.type === 'InspectionFindingRecorded') return { ...s, version: e.streamVersion, findingIds: [...s.findingIds, String(p.findingId)] }
  return { ...s, version: e.streamVersion }
}

export function foldCar(carId: string, events: Array<CaseEventLike & { recordedAt?: string }>): CarState {
  return events.reduce(applyCarEvent, initialCar(carId))
}

export function currentComponent(s: CarState, axle: number): AxleInstall | null {
  return s.installs.filter((i) => i.axle === axle && i.removedAtMs === null).sort((a, b) => b.installedAtMs - a.installedAtMs)[0] ?? null
}

export type ReplaceDecision = { kind: 'recorded'; events: NewEvent[] } | { kind: 'replayed'; eventId: string }

export function decideReplaceComponent(
  s: CarState,
  i: { axle: number; componentId: string; installedAt: string; recordedBy: string; findingId: string | null; caseId: string | null; clientSubmissionId: string | null },
): ReplaceDecision {
  const key = i.clientSubmissionId ?? (i.findingId ? `finding:${i.findingId}` : null)
  if (key && s.submissions[key]) return { kind: 'replayed', eventId: s.submissions[key] }
  const current = currentComponent(s, i.axle)
  const at = new Date(i.installedAt).getTime()
  if (current && current.installedAtMs >= at) {
    throw new DomainError('NEWER_INSTALL_EXISTS', 'A wheelset installed later than this one is already recorded on that axle')
  }
  return {
    kind: 'recorded',
    events: [{
      type: 'ComponentReplaced',
      occurredAt: i.installedAt,
      tags: [`car:${s.carId}`, ...(i.caseId ? [`case:${i.caseId}`] : [])],
      payload: {
        carId: s.carId, axle: i.axle, removedComponentId: current?.componentId ?? null, installedComponentId: i.componentId, installedAt: i.installedAt,
        recordedBy: i.recordedBy, findingId: i.findingId, caseId: i.caseId, clientSubmissionId: i.clientSubmissionId,
      },
    }],
  }
}

export function decideCarFinding(
  s: CarState,
  i: { source: 'routine' | 'teardown'; position: string; finding: string; disposition: string; notes: string | null; recordedBy: string; observedAt: string; clientSubmissionId: string | null },
): NewEvent[] {
  return [{
    type: 'InspectionFindingRecorded',
    occurredAt: i.observedAt,
    tags: [`car:${s.carId}`],
    payload: {
      caseId: null, findingId: randomUUID(), workOrderId: null, clientSubmissionId: i.clientSubmissionId, carId: s.carId, position: i.position,
      finding: i.finding, disposition: i.disposition, notes: i.notes, recordedBy: i.recordedBy, observedAt: i.observedAt, replacement: null,
      source: i.source, supersedesFindingId: null,
    },
  }]
}

/** car|axle -> install time of the wheelset on that axle now (what the analyzer filters readings by). */
export function installCutoffs(cars: CarState[]): Map<string, number> {
  const out = new Map<string, number>()
  for (const c of cars) for (const i of c.installs) if (i.removedAtMs === null) out.set(`${c.carId}|${i.axle}`, Math.max(out.get(`${c.carId}|${i.axle}`) ?? 0, i.installedAtMs))
  return out
}
