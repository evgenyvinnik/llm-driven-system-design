import { describe, expect, it } from 'vitest'
import { applyCarEvent, currentComponent, decideReplaceComponent, foldCar, initialCar, installCutoffs } from './car.js'
import { DomainError } from './case.js'

const install = (axle: number, componentId: string, installedAt: string, extra: Partial<{ clientSubmissionId: string; findingId: string }> = {}) => ({
  axle, componentId, installedAt, recordedBy: 'bob', findingId: extra.findingId ?? null, caseId: null, clientSubmissionId: extra.clientSubmissionId ?? null,
})

describe('car aggregate: component history', () => {
  it('rebuilds what is on each axle from ComponentReplaced events', () => {
    let car = initialCar('SVTX 961204')
    for (const [i, cmd] of [install(4, 'WS-1', '2026-11-01T10:00:00Z'), install(4, 'WS-2', '2026-11-05T10:00:00Z'), install(1, 'WS-9', '2026-11-03T10:00:00Z')].entries()) {
      const d = decideReplaceComponent(car, cmd)
      if (d.kind !== 'recorded') throw new Error('expected recorded')
      car = applyCarEvent(car, { type: d.events[0].type, payload: d.events[0].payload, streamVersion: i + 1, eventId: `e${i}`, occurredAt: String(cmd.installedAt) })
    }
    expect(currentComponent(car, 4)?.componentId).toBe('WS-2')
    expect(car.installs.find((i) => i.componentId === 'WS-1')?.removedAtMs).toBe(Date.parse('2026-11-05T10:00:00Z'))
    expect(installCutoffs([car]).get('SVTX 961204|4')).toBe(Date.parse('2026-11-05T10:00:00Z'))
  })

  it('names the wheelset it replaces, and refuses an install older than the current one on that axle', () => {
    const car = foldCar('C1', [{ type: 'ComponentReplaced', streamVersion: 1, eventId: 'e1', occurredAt: '2026-11-05T10:00:00Z', payload: { carId: 'C1', axle: 2, installedComponentId: 'WS-A', installedAt: '2026-11-05T10:00:00Z' } }])
    const d = decideReplaceComponent(car, install(2, 'WS-B', '2026-11-05T12:00:00Z'))
    expect(d.kind === 'recorded' && d.events[0].payload.removedComponentId).toBe('WS-A')
    expect(() => decideReplaceComponent(car, install(2, 'WS-OLD', '2026-11-04T10:00:00Z'))).toThrow(DomainError)
  })

  it('applies a tablet submission (or a repair finding) once', () => {
    const car = foldCar('C1', [{ type: 'ComponentReplaced', streamVersion: 1, eventId: 'e1', occurredAt: '2026-11-05T10:00:00Z', payload: { carId: 'C1', axle: 2, installedComponentId: 'WS-A', installedAt: '2026-11-05T10:00:00Z', clientSubmissionId: 'tab-1', findingId: 'f-1' } }])
    expect(decideReplaceComponent(car, install(2, 'WS-A', '2026-11-05T10:00:00Z', { clientSubmissionId: 'tab-1' }))).toEqual({ kind: 'replayed', eventId: 'e1' })
    expect(decideReplaceComponent(car, install(2, 'WS-A', '2026-11-05T10:00:00Z', { findingId: 'f-1' }))).toEqual({ kind: 'replayed', eventId: 'e1' })
  })
})
