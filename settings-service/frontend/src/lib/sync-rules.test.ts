import { describe, expect, it } from 'vitest'
import type { EffectiveDoc, EffectiveEntry, UserChangedEvent } from '@/types'
import { applyDelta, classifyOutcome, decideHello, decideScopedEvent, decideUserEvent, isNewerOrSame, reconcileAfterUnknown } from './sync-rules'

const revs = (revision: number, orgRevision = 6, catalogRevision = 1) => ({ revision, orgRevision, catalogRevision })
const entry = (value: EffectiveEntry['value'], source: EffectiveEntry['source'] = 'user', extra: Partial<EffectiveEntry> = {}): EffectiveEntry => ({
  value,
  source,
  locked: source === 'enforced',
  lockReason: source === 'enforced' ? 'enforced' : null,
  rev: 1,
  ...extra,
})

describe('classifyOutcome', () => {
  it('separates success, definite refusals and unknown outcomes', () => {
    expect(classifyOutcome(200, false)).toBe('success')
    expect(classifyOutcome(409, true)).toBe('rejected')
    expect(classifyOutcome(422, true)).toBe('rejected')
    // A 4xx without our envelope came from something else (a proxy); we can't trust it.
    expect(classifyOutcome(404, false)).toBe('unknown')
    expect(classifyOutcome(500, true)).toBe('unknown')
    expect(classifyOutcome(502, false)).toBe('unknown')
  })
})

describe('decideUserEvent', () => {
  it('ignores events we already have (including our own echo)', () => {
    expect(decideUserEvent(revs(14), revs(14))).toBe('ignore')
    expect(decideUserEvent(revs(14), revs(12))).toBe('ignore')
  })
  it('applies the next revision as a delta', () => {
    expect(decideUserEvent(revs(14), revs(15))).toBe('apply')
  })
  it('refetches on a revision gap', () => {
    expect(decideUserEvent(revs(14), revs(16))).toBe('refetch')
  })
  it('refetches when the delta was resolved against different org or catalog state', () => {
    expect(decideUserEvent(revs(14, 6), revs(15, 7))).toBe('refetch')
    expect(decideUserEvent(revs(14, 6, 1), revs(15, 6, 2))).toBe('refetch')
  })
  it('refetches when nothing is loaded yet', () => {
    expect(decideUserEvent(null, revs(1))).toBe('refetch')
  })
})

describe('decideScopedEvent and decideHello', () => {
  it('refetches only for newer org/catalog revisions', () => {
    expect(decideScopedEvent(6, 7)).toBe('refetch')
    expect(decideScopedEvent(7, 7)).toBe('ignore')
  })
  it('refetches after reconnect if anything moved, and forces adoption if the server went backwards', () => {
    expect(decideHello(revs(14), revs(14))).toEqual({ refetch: false, force: false })
    expect(decideHello(revs(14), revs(16))).toEqual({ refetch: true, force: false })
    expect(decideHello(revs(14, 6), revs(14, 7))).toEqual({ refetch: true, force: false })
    expect(decideHello(revs(14), revs(9))).toEqual({ refetch: true, force: true })
  })
})

describe('isNewerOrSame', () => {
  it('never lets a slow GET overwrite a newer PATCH response', () => {
    expect(isNewerOrSame(revs(14), revs(15))).toBe(false)
    expect(isNewerOrSame(revs(15), revs(15))).toBe(true)
    expect(isNewerOrSame(revs(15, 7), revs(15, 6))).toBe(true)
    expect(isNewerOrSame(revs(15, 5), revs(15, 6))).toBe(false)
  })
})

describe('applyDelta', () => {
  it('replaces only the changed keys and moves the revisions', () => {
    const doc: EffectiveDoc = { ...revs(14), settings: { a: entry('x'), b: entry(1, 'default') } }
    const ev = { type: 'user', ...revs(15), userId: 'u', changes: { a: entry('y') }, clientId: null, clientLabel: 'Phone', origin: 'api-a', at: '' } as UserChangedEvent
    const next = applyDelta(doc, ev)
    expect(next.revision).toBe(15)
    expect(next.settings.a.value).toBe('y')
    expect(next.settings.b).toBe(doc.settings.b)
  })
})

describe('reconcileAfterUnknown', () => {
  const doc: EffectiveDoc = {
    ...revs(15),
    settings: {
      theme: entry('dark'),
      lang: entry('en-US', 'org'),
      receipts: entry(true, 'enforced', { userValue: false }),
    },
  }
  it('finds which sent keys actually landed', () => {
    expect(reconcileAfterUnknown(doc, { theme: 'dark', lang: 'de-DE' })).toEqual({ landed: ['theme'], notLanded: ['lang'] })
  })
  it('treats a reset as landed when no user value remains', () => {
    expect(reconcileAfterUnknown(doc, { lang: null })).toEqual({ landed: ['lang'], notLanded: [] })
    expect(reconcileAfterUnknown(doc, { theme: null })).toEqual({ landed: [], notLanded: ['theme'] })
  })
  it('sees the user value underneath an enforcement', () => {
    expect(reconcileAfterUnknown(doc, { receipts: false })).toEqual({ landed: ['receipts'], notLanded: [] })
  })
})
