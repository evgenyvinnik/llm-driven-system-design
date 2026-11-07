import { describe, expect, it } from 'vitest'
import { compileSnapshot, etagMatches, snapshotEtag, type CompilableFlag } from './compile.js'

const flag = (key: string, extra: Partial<CompilableFlag> = {}): CompilableFlag => ({
  key,
  kind: 'experiment',
  unitType: 'user',
  salt: `${key}-salt`,
  variants: [
    { key: 'control', name: 'Control' },
    { key: 'treatment', name: 'Treatment' },
  ],
  defaultVariant: 'control',
  status: 'running',
  version: 1,
  rules: [],
  fallthrough: 'enroll',
  allocation: { control: [[0, 5000]], treatment: [[5000, 10_000]] },
  ...extra,
})

describe('compileSnapshot', () => {
  it('produces a self-contained, key-sorted, versioned document', () => {
    const at = new Date('2026-11-06T12:00:00Z')
    const snap = compileSnapshot('prod', 42, [flag('zeta'), flag('alpha', { status: 'paused' })], at)
    expect(snap).toMatchObject({ schema: 1, environment: 'prod', version: 42, compiledAt: '2026-11-06T12:00:00.000Z' })
    expect(Object.keys(snap.flags)).toEqual(['alpha', 'zeta'])
    expect(snap.flags.alpha.status).toBe('paused')
    expect(snap.flags.zeta.salt).toBe('zeta-salt')
  })
})

describe('ETags', () => {
  it('names the environment and version and matches If-None-Match lists, weak tags and *', () => {
    const etag = snapshotEtag('prod', 7)
    expect(etag).toBe('"prod-v7"')
    expect(etagMatches('"prod-v7"', etag)).toBe(true)
    expect(etagMatches('W/"prod-v7"', etag)).toBe(true)
    expect(etagMatches('"prod-v6", "prod-v7"', etag)).toBe(true)
    expect(etagMatches('*', etag)).toBe(true)
    expect(etagMatches('"prod-v6"', etag)).toBe(false)
    expect(etagMatches(undefined, etag)).toBe(false)
  })
})
