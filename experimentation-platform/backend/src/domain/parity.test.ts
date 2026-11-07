/**
 * Server/SDK parity. The server evaluates with shared/evaluation (the same
 * module the SDK uses); this test checks the parts that could still diverge:
 * the snapshot's JSON round trip, the SDK client's context handling, and the
 * hash itself against an independently written reference implementation.
 */
import { describe, expect, it } from 'vitest'
import { ExperimentClient } from '../../../sdk/src/client/client.js'
import { allocateStable, bucketOf, evaluate, type EvalContext } from '../shared/evaluation.js'
import { compileSnapshot, type CompilableFlag } from './compile.js'

/** MurmurHash3_x86_32 written differently: Buffer reads and BigInt arithmetic. */
function referenceMurmur(text: string, seed = 0): number {
  const buf = Buffer.from(text, 'utf8')
  const M = 0xffffffffn
  const mul = (a: bigint, b: bigint) => (a * b) & M
  const rotl = (x: bigint, r: bigint) => ((x << r) | (x >> (32n - r))) & M
  let h = BigInt(seed)
  let i = 0
  for (; i + 4 <= buf.length; i += 4) {
    let k = BigInt(buf.readUInt32LE(i))
    k = mul(rotl(mul(k, 0xcc9e2d51n), 15n), 0x1b873593n)
    h = rotl(h ^ k, 13n)
    h = (mul(h, 5n) + 0xe6546b64n) & M
  }
  let k = 0n
  const rest = buf.length - i
  if (rest === 3) k ^= BigInt(buf[i + 2]) << 16n
  if (rest >= 2) k ^= BigInt(buf[i + 1]) << 8n
  if (rest >= 1) {
    k ^= BigInt(buf[i])
    h ^= mul(rotl(mul(k, 0xcc9e2d51n), 15n), 0x1b873593n)
  }
  h ^= BigInt(buf.length)
  h ^= h >> 16n
  h = mul(h, 0x85ebca6bn)
  h ^= h >> 13n
  h = mul(h, 0xc2b2ae35n)
  h ^= h >> 16n
  return Number(h)
}

function rng(seed: number) {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 2 ** 32
  }
}

const flags: CompilableFlag[] = [
  {
    key: 'checkout_cta',
    kind: 'experiment',
    unitType: 'user',
    salt: 'checkout_cta-1a2b',
    variants: [
      { key: 'control', name: 'Add to cart', value: 'Add to cart' },
      { key: 'treatment', name: 'Buy now', value: 'Buy now' },
    ],
    defaultVariant: 'control',
    status: 'running',
    version: 5,
    rules: [
      { id: 'qa', description: '', conditions: [{ attribute: 'id', operator: 'in', values: ['qa-1'] }], action: { type: 'force', variant: 'treatment' } },
      { id: 'no-de', description: '', conditions: [{ attribute: 'country', operator: 'in', values: ['DE'] }], action: { type: 'exclude' } },
    ],
    fallthrough: 'enroll',
    allocation: allocateStable(allocateStable({}, { control: 9000, treatment: 1000 }), { control: 6000, treatment: 3000 }),
  },
  {
    key: 'team_dashboard',
    kind: 'experiment',
    unitType: 'org',
    salt: 'team-9',
    variants: [
      { key: 'table', name: 'Table' },
      { key: 'cards', name: 'Cards' },
      { key: 'grid', name: 'Grid' },
    ],
    defaultVariant: 'table',
    status: 'running',
    version: 2,
    rules: [],
    fallthrough: 'enroll',
    allocation: allocateStable({}, { table: 3334, cards: 3333, grid: 3333 }),
  },
  {
    key: 'promo_ribbon',
    kind: 'flag',
    unitType: 'anonymous',
    salt: 'promo-3',
    variants: [
      { key: 'off', name: 'Off', value: false },
      { key: 'on', name: 'On', value: true },
    ],
    defaultVariant: 'off',
    status: 'running',
    version: 3,
    rules: [],
    fallthrough: 'enroll',
    allocation: { on: [[0, 2500]] },
  },
]

describe('server / SDK parity', () => {
  it('the shared bucket function matches an independent MurmurHash3 implementation', () => {
    const next = rng(7)
    for (let i = 0; i < 5_000; i++) {
      const unit = `unit-${Math.floor(next() * 1e9).toString(36)}-é${i}`
      expect(bucketOf('salt-x', unit)).toBe(referenceMurmur(`salt-x.${unit}`) % 10_000)
    }
  })

  it('server evaluation and an SDK client holding the JSON snapshot agree on 5,000 random units', () => {
    const snapshot = compileSnapshot('prod', 18, flags)
    const sdk = new ExperimentClient({ apiUrl: 'http://unused', clientKey: 'cli', bootstrap: JSON.parse(JSON.stringify(snapshot)), stream: false })
    const next = rng(42)
    const countries = ['US', 'CA', 'DE', 'GB', undefined]
    let compared = 0
    for (let i = 0; i < 5_000; i++) {
      const anon = `anon_${Math.floor(next() * 1e12).toString(36)}`
      const ctx: EvalContext = {
        anonymousId: anon,
        stableId: next() < 0.3 ? `anon_${Math.floor(next() * 1e12).toString(36)}` : anon,
        orgId: next() < 0.5 ? `org_${Math.floor(next() * 300)}` : undefined,
        attributes: { country: countries[Math.floor(next() * countries.length)] },
      }
      if (i === 0) ctx.stableId = 'qa-1'
      for (const key of Object.keys(snapshot.flags)) {
        expect(sdk.peek(key, ctx)).toEqual(evaluate(snapshot, key, ctx))
        compared++
      }
    }
    expect(compared).toBe(15_000)
    expect(evaluate(snapshot, 'checkout_cta', { stableId: 'qa-1' })).toMatchObject({ variant: 'treatment', reason: 'forced' })
  })
})
