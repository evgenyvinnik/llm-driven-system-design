import { describe, expect, it } from 'vitest'
import { hedged, HedgeBudget, percentile, SingleFlight } from './resilience.js'
import { backoffMs, decide, PermanentError } from './consumer.js'
import { componentCacheKey, coalesceKey } from './cache-keys.js'
import { sortableVersion, tariffFloorValue } from './component-cache.js'
import { signPayload, verifySignature } from './signing.js'
import { admits } from '../api/services/admission.js'
import { DEFAULT_SETTINGS } from './settings.js'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe('single-flight', () => {
  it('collapses identical concurrent calls into one', async () => {
    const sf = new SingleFlight()
    let calls = 0
    const fn = async () => {
      calls += 1
      await sleep(20)
      return 42
    }
    const a = sf.do('k', fn)
    const b = sf.do('k', fn)
    expect(a.shared).toBe(false)
    expect(b.shared).toBe(true)
    expect(await Promise.all([a.promise, b.promise])).toEqual([42, 42])
    expect(calls).toBe(1)
    expect(sf.size).toBe(0)
    await sf.do('k', fn).promise
    expect(calls).toBe(2)
  })
})

describe('hedged requests', () => {
  it('returns the hedge when the first attempt is in the slow tail, and aborts the loser', async () => {
    let aborted = 0
    let hedges = 0
    const t0 = Date.now()
    const value = await hedged(
      (signal, n) =>
        new Promise<string>((resolve) => {
          const t = setTimeout(() => resolve(`attempt-${n}`), n === 1 ? 500 : 10)
          signal.addEventListener('abort', () => {
            clearTimeout(t)
            aborted += 1
          })
        }),
      { delayMs: 30, canHedge: () => true, onHedge: () => (hedges += 1) },
    )
    expect(value).toBe('attempt-2')
    expect(hedges).toBe(1)
    expect(aborted).toBe(1)
    expect(Date.now() - t0).toBeLessThan(200)
  })

  it('does not hedge a fast failure', async () => {
    let attempts = 0
    await expect(
      hedged(
        async () => {
          attempts += 1
          throw new Error('boom')
        },
        { delayMs: 20, canHedge: () => true },
      ),
    ).rejects.toThrow('boom')
    await sleep(40)
    expect(attempts).toBe(1)
  })

  it('caps hedges with a budget', () => {
    const budget = new HedgeBudget(10, 1)
    expect(budget.tryTake()).toBe(true)
    expect(budget.tryTake()).toBe(false)
    for (let i = 0; i < 9; i += 1) budget.onCall()
    expect(budget.tryTake()).toBe(false)
    budget.onCall()
    expect(budget.tryTake()).toBe(true)
  })

  it('computes nearest-rank percentiles', () => {
    expect(percentile([5, 1, 3, 2, 4], 50)).toBe(3)
    expect(percentile(Array.from({ length: 100 }, (_, i) => i + 1), 99)).toBe(99)
    expect(percentile([], 99)).toBeNull()
  })
})

describe('consumer retry policy (DLQ routing)', () => {
  it('retries transient failures with exponential backoff, then dead-letters', () => {
    const err = new Error('capacity down')
    expect(decide(err, 1, 5)).toBe('retry')
    expect(decide(err, 4, 5)).toBe('retry')
    expect(decide(err, 5, 5)).toBe('dead_letter')
    expect([1, 2, 3, 4].map((d) => backoffMs(d, 1_000))).toEqual([1_000, 2_000, 4_000, 8_000])
  })

  it('dead-letters permanent failures on the first delivery', () => {
    expect(decide(new PermanentError('quote not found'), 1, 5)).toBe('dead_letter')
  })
})

describe('cache keys and version floors', () => {
  const base = { origin: 'KCK', destination: 'CHI', commodity: 'GRAIN', equipment: 'COVERED_HOPPER', shipWeek: '2026-11-23', quantity: 10 }
  it('never lets a contract price share a key with the tariff or another contract', () => {
    const tariff = componentCacheKey('pricing', { ...base, contractId: null })
    const contract = componentCacheKey('pricing', { ...base, contractId: 'CTR-PGC-2026' })
    expect(tariff).not.toBe(contract)
    expect(contract).toContain('CTR-PGC-2026')
    expect(coalesceKey('pricing', { ...base, contractId: 'CTR-PGC-2026' })).not.toBe(coalesceKey('pricing', { ...base, contractId: null }))
    expect(componentCacheKey('capacity', { ...base, contractId: 'CTR-PGC-2026' })).toBe(componentCacheKey('capacity', { ...base, contractId: null }))
  })

  it('orders versions so a floor compares correctly as a string', () => {
    expect(tariffFloorValue(10) > tariffFloorValue(9)).toBe(true)
    const v9 = sortableVersion('pricing', { basis: 'tariff', contractId: null, contractVersion: null, tariffId: 't', tariffVersion: 9, ratePerCarCents: 1, asOf: '' })
    expect(v9 < tariffFloorValue(10)).toBe(true)
    const original = sortableVersion('fuel', { effectiveDate: '2026-11-02', centsPerMile: 42, miles: 1, amountPerCarCents: 1, asOf: '2026-11-02T06:00:00.000Z' })
    const correction = `2026-11-02|2026-11-03T09:00:00.000Z`
    expect(original < correction).toBe(true)
  })
})

describe('load shedding by client class', () => {
  const s = { ...DEFAULT_SETTINGS.shedding, maxInflight: 40 }
  it('sheds re-quoting integrations first, then integrations, then the portal', () => {
    expect(admits(15, 'api_requote', s)).toBe(true)
    expect(admits(16, 'api_requote', s)).toBe(false)
    expect(admits(29, 'api', s)).toBe(true)
    expect(admits(30, 'api', s)).toBe(false)
    expect(admits(39, 'portal', s)).toBe(true)
    expect(admits(40, 'portal', s)).toBe(false)
    expect(admits(1_000, 'api_requote', { ...s, enabled: false })).toBe(true)
  })
})

describe('webhook signatures', () => {
  it('verifies, and rejects tampering and stale timestamps', () => {
    const body = '{"event_id":"e1"}'
    const header = signPayload('whsec_x', body, 1_000)
    expect(verifySignature('whsec_x', body, header, 1_010)).toEqual({ ok: true })
    expect(verifySignature('whsec_x', body + ' ', header, 1_010)).toEqual({ ok: false, reason: 'mismatch' })
    expect(verifySignature('whsec_y', body, header, 1_010)).toEqual({ ok: false, reason: 'mismatch' })
    expect(verifySignature('whsec_x', body, header, 2_000)).toEqual({ ok: false, reason: 'expired' })
    expect(verifySignature('whsec_x', body, undefined, 1_000)).toEqual({ ok: false, reason: 'malformed' })
  })
})
