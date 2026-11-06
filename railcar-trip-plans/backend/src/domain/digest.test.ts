import { describe, expect, it } from 'vitest'
import { buildDigest, type DigestItem } from './digest.js'

const eta = (carId: string, p50: string, at: string): DigestItem => ({
  carId, kind: 'eta_change', occurredAt: at, payload: { p10: p50, p50, p90: p50, planVersion: 1 },
})

describe('buildDigest (fan-out with batching)', () => {
  it('collapses many events for many cars into one line per car', () => {
    // A delayed train: every car gets two ETA updates (the delay grows) inside one window.
    const items: DigestItem[] = []
    for (let i = 0; i < 40; i++) {
      items.push(eta(`HPSX${i}`, '2026-11-05T09:00:00.000Z', '2026-11-04T06:00:00.000Z'))
      items.push(eta(`HPSX${i}`, '2026-11-05T12:00:00.000Z', '2026-11-04T08:00:00.000Z'))
    }
    const last = new Map(Array.from({ length: 40 }, (_, i) => [`HPSX${i}`, { p50: '2026-11-05T06:00:00.000Z', planVersion: 1 }]))
    const d = buildDigest(items, last, 120)
    expect(d.lines).toHaveLength(40)
    expect(d.suppressed).toBe(40)
    expect(d.lines[0].text).toContain('+6 h vs last update')
    expect(d.told.get('HPSX0')?.p50).toBe('2026-11-05T12:00:00.000Z')
  })

  it('suppresses an ETA that wandered and came back within the threshold', () => {
    const items = [eta('HPSX1', '2026-11-05T12:00:00.000Z', '2026-11-04T06:00:00.000Z'), eta('HPSX1', '2026-11-05T06:30:00.000Z', '2026-11-04T07:00:00.000Z')]
    const d = buildDigest(items, new Map([['HPSX1', { p50: '2026-11-05T06:00:00.000Z', planVersion: 1 }]]), 120)
    expect(d.lines).toHaveLength(0)
    expect(d.suppressed).toBe(2)
  })

  it('always reports a replan, with the new ETA, even if the ETA barely moved', () => {
    const items: DigestItem[] = [
      { carId: 'HPSX1', kind: 'replanned', occurredAt: '2026-11-04T09:00:00.000Z', payload: { fromPlanVersion: 1, toPlanVersion: 2, reasonText: 'Missed M-MIDPRT. Moved to Z-MIDPRT.', etaAfter: { p10: '2026-11-05T05:00:00.000Z', p50: '2026-11-05T06:30:00.000Z', p90: '2026-11-05T10:00:00.000Z' } } },
    ]
    const d = buildDigest(items, new Map([['HPSX1', { p50: '2026-11-05T06:00:00.000Z', planVersion: 1 }]]), 120)
    expect(d.lines[0].text).toContain('plan v1 → v2')
    expect(d.told.get('HPSX1')?.planVersion).toBe(2)
  })

  it('reports delivery instead of the ETA changes that preceded it', () => {
    const items: DigestItem[] = [eta('HPSX1', '2026-11-05T12:00:00.000Z', '2026-11-04T06:00:00.000Z'), { carId: 'HPSX1', kind: 'delivered', occurredAt: '2026-11-05T11:00:00.000Z', payload: {} }]
    const d = buildDigest(items, new Map(), 120)
    expect(d.lines).toHaveLength(1)
    expect(d.lines[0].text).toContain('delivered')
    expect(d.subject).toContain('1 delivered')
  })
})
