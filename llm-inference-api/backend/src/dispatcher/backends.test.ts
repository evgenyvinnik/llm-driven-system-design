import { describe, expect, it, vi } from 'vitest'

vi.mock('../shared/cache.js', () => ({ redis: {}, keys: {} }))
const { BackendRegistry } = await import('./backends.js')

function registry() {
  const r = new BackendRegistry([{ id: 'b1', url: 'http://x' }])
  const s = r.states.get('b1')!
  s.reachable = true
  s.health = { status: 'ok', slots: 8, inUse: 4 } as never
  return { r, s }
}

describe('backend registry load view', () => {
  it('ignores a health report taken before work finished locally (stale routing info)', () => {
    const { r, s } = registry()
    s.healthAt = 1000
    s.inflight = 4
    r.releaseInflight('b1', 4) // finished after the report
    expect(r.loads().get('b1')!.inUse).toBe(0)
  })

  it('uses the report when it is newer than the last release (work it cannot see locally)', () => {
    const { r, s } = registry()
    s.lastReleaseAt = 1000
    s.healthAt = 2000
    s.inflight = 1
    expect(r.loads().get('b1')!.inUse).toBe(4)
  })

  it('a draining refusal or overload corrects routability before the next poll', () => {
    const { r } = registry()
    r.markRefused('b1', 'draining', 503)
    expect(r.loads().get('b1')!.routable).toBe(false)
    const { r: r2 } = registry()
    r2.markRefused('b1', 'overloaded', 529)
    expect(r2.loads().get('b1')!.routable).toBe(false)
  })
})
