import { describe, expect, it } from 'vitest'
import { canonicalString, parseSearch, resolveQuery, toUrlSearch, withoutDimension } from './filters'

const LA = 'America/Los_Angeles'
// Monday Nov 2, 2026, 20:00 PST — the day after DST ended.
const NOW = Date.parse('2026-11-03T04:00:00Z')

describe('resolveQuery', () => {
  it('turns "last 7 days" into local midnights, across the DST change', () => {
    const q = resolveQuery(parseSearch({ org: 'larkspur' }), 'larkspur', LA, NOW)
    expect(q.from).toBe('2026-10-27T07:00:00.000Z') // Oct 27 00:00 PDT
    expect(q.to).toBe('2026-11-03T08:00:00.000Z') // Nov 3 00:00 PST
    expect(q.grain).toBe('day')
  })

  it('starts "today" at 18:30 UTC in Kolkata', () => {
    const q = resolveQuery(parseSearch({ range: 'today' }), 'kestrel', 'Asia/Kolkata', NOW)
    expect(q.from).toBe('2026-11-02T18:30:00.000Z')
    expect(q.grain).toBe('hour')
  })

  it('keeps the same key all day, so the cache is not re-keyed every tick', () => {
    const s = parseSearch({ range: '28d', models: 'orion-swift' })
    const a = canonicalString(resolveQuery(s, 'larkspur', LA, NOW))
    const b = canonicalString(resolveQuery(s, 'larkspur', LA, NOW + 3 * 3_600_000))
    expect(a).toBe(b)
  })

  it('falls back to a grain that fits the span', () => {
    expect(resolveQuery(parseSearch({ range: '28d', grain: 'minute' }), 'larkspur', LA, NOW).grain).toBe('day')
    expect(resolveQuery(parseSearch({ range: '24h', grain: 'minute' }), 'larkspur', LA, NOW).grain).toBe('minute')
  })
})

describe('canonical string', () => {
  it('matches the server: sorted, de-duplicated lists, fixed key order, defaults kept', () => {
    const s = parseSearch({ org: 'larkspur', models: 'orion-swift,orion-large,orion-swift', compare: 'none' })
    const q = { ...resolveQuery(s, 'larkspur', LA, NOW), from: '2026-10-05T07:00:00.000Z', to: '2026-10-12T07:00:00.000Z' }
    expect(canonicalString(q, { metric: 'conversations' })).toBe(
      'org=larkspur&from=2026-10-05T07:00:00.000Z&to=2026-10-12T07:00:00.000Z&grain=day&models=orion-large,orion-swift&compare=none&metric=conversations',
    )
  })

  it('gives a breakdown widget its own key without its own dimension (cross-filtering)', () => {
    const q = resolveQuery(parseSearch({ models: 'orion-think', features: 'web_search' }), 'larkspur', LA, NOW)
    expect(withoutDimension(q, 'model').models).toEqual([])
    expect(withoutDimension(q, 'model').features).toEqual(['web_search'])
    expect(canonicalString(withoutDimension(q, 'model'))).not.toBe(canonicalString(q))
  })
})

describe('URL state', () => {
  it('ignores garbage instead of breaking the page', () => {
    const s = parseSearch({ range: 'forever', compare: 'yoy', features: 'web_search,teleport', drill: 'not-a-date' })
    expect(s.range).toBe('7d')
    expect(s.compare).toBe('wow')
    expect(s.features).toEqual(['web_search'])
    expect(s.drill).toBeUndefined()
  })

  it('round-trips and drops defaults from the URL', () => {
    const s = parseSearch({ org: 'kestrel', range: '28d', models: 'b,a', metric: 'error_rate' })
    expect(toUrlSearch(s)).toEqual({ org: 'kestrel', range: '28d', from: undefined, to: undefined, grain: undefined, compare: undefined, models: 'a,b', features: undefined, metric: 'error_rate', drill: undefined })
    expect(parseSearch(toUrlSearch(s))).toEqual(s)
  })
})
