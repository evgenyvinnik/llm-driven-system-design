import { describe, expect, it, vi } from 'vitest'

vi.mock('../shared/db.js', () => ({ pool: { query: vi.fn() }, withTransaction: vi.fn() }))
vi.mock('../shared/live.js', () => ({ publishLive: vi.fn() }))

const { plan } = await import('./notifier.js')

const base = { eventId: 'e', version: 1, occurredAt: '2026-11-06T20:00:00Z', recordedAt: '2026-11-06T20:00:00Z', streamId: 'hazard-h', streamVersion: 2, partitionKey: 'PRA-7', correlationId: 'c', causationId: null, source: 'alerting', meta: {} }

describe('notification plan', () => {
  it('pages and puts a CRITICAL alert on the console of the territory dispatcher', () => {
    const out = plan({ ...base, type: 'AlertIssued', payload: { hazardId: 'h', alertId: 'AL-1', severity: 'CRITICAL', deskId: 'EAST', assignee: 'dan', ackDeadlineAt: base.occurredAt, summary: 'Obstruction', lane: 'critical', late: false, timing: {} } })
    expect(out.map((p) => `${p.channel}:${p.recipient}`)).toEqual(['console:dan', 'pager:dan'])
  })
  it('radios warned trains one after another, nearest first', () => {
    const out = plan({
      ...base,
      type: 'TrainsWarned',
      payload: { hazardId: 'h', instruction: 'Stop short of MP 241.8', automatic: true, by: 'alerting', trains: [{ symbol: 'Z-CHIPRA', etaMinutes: 16 }, { symbol: 'M-PRACAN', etaMinutes: 38 }] },
    })
    expect(out.map((p) => [p.recipient, p.order])).toEqual([
      ['Z-CHIPRA', 0],
      ['M-PRACAN', 1],
    ])
  })
  it('sends nothing for events people are not notified about', () => {
    expect(plan({ ...base, type: 'HazardEvidenceAdded', payload: {} })).toEqual([])
  })
})
