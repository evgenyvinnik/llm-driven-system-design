import { afterEach, describe, expect, it } from 'vitest'
import { ExperimentClient } from './client.js'
import { parseSse } from './sse.js'
import { memoryStorage } from './storage.js'
import { fakeServer, snapshot, until, type FakeServer } from './test-helpers.js'

const clients: ExperimentClient[] = []
function client(server: FakeServer, extra: Partial<ConstructorParameters<typeof ExperimentClient>[0]> = {}) {
  const c = new ExperimentClient({ apiUrl: 'http://sdk.test/sdk/v1', clientKey: 'cli_test', fetch: server.fetch, stream: false, initTimeoutMs: 200, flushIntervalMs: 60_000, ...extra })
  clients.push(c)
  return c
}
afterEach(async () => {
  for (const c of clients.splice(0)) await c.close()
})

describe('startup without the network', () => {
  it('serves safe coded defaults when nothing is cached, and ready() still resolves', async () => {
    const server = fakeServer(snapshot(3))
    server.down = true
    const c = client(server, { defaults: { checkout_cta: 'control' }, context: { anonymousId: 'a1' } })
    const t0 = Date.now()
    expect(await c.start()).toBe('defaults')
    expect(Date.now() - t0).toBeLessThan(1_000)
    expect(c.peek('checkout_cta')).toMatchObject({ variant: 'control', reason: 'default', inExperiment: false })
    expect(c.peek('unknown')).toMatchObject({ variant: null, reason: 'default' })
  })

  it('evaluates from the last known good snapshot in storage when the server is down', async () => {
    const storage = memoryStorage()
    const online = fakeServer(snapshot(7))
    const first = client(online, { storage, context: { stableId: 'u1' } })
    await first.start()
    const expected = first.peek('checkout_cta')
    await first.close()

    const offline = fakeServer(null)
    offline.down = true
    const second = client(offline, { storage, context: { stableId: 'u1' } })
    expect(second.getState().source).toBe('cache')
    expect(second.peek('checkout_cta')).toEqual(expected)
    expect(await second.start()).toBe('cache')
    expect(second.getState().lastError).toMatch(/fetch failed/)
  })

  it('ignores a cached snapshot older than maxCacheAgeMs', async () => {
    const storage = memoryStorage()
    let now = Date.now()
    const c1 = client(fakeServer(snapshot(2)), { storage, now: () => now })
    await c1.start()
    await c1.close()
    now += 8 * 86_400_000
    const offline = fakeServer(null)
    offline.down = true
    const c2 = client(offline, { storage, now: () => now })
    expect(c2.getState().source).toBe('defaults')
  })
})

describe('snapshot transport', () => {
  it('revalidates with If-None-Match and keeps the snapshot on 304', async () => {
    const server = fakeServer(snapshot(4))
    const c = client(server)
    await c.start()
    await c.fetchLatest()
    const gets = server.calls.filter((x) => x.url.endsWith('/snapshot'))
    expect(gets[0].headers['If-None-Match']).toBeUndefined()
    expect(gets[1].headers['If-None-Match']).toBe('"prod-v4"')
    expect(c.getState().version).toBe(4)
    expect(c.getState().source).toBe('network')
  })

  it('never goes back to an older version and rejects malformed snapshots', async () => {
    const c = client(fakeServer(snapshot(9)))
    await c.start()
    expect(c.apply(snapshot(5), null)).toBe(false)
    expect(c.getState().version).toBe(9)
    expect(c.apply({ nope: true } as never, null)).toBe(false)
  })

  it('applies a pushed version from the stream', async () => {
    const server = fakeServer(snapshot(1))
    const c = client(server, { stream: true })
    await c.start()
    await until(() => c.getState().connection === 'live' && c.getState().version === 1)
    server.current = snapshot(2, { checkout_cta: { status: 'stopped', version: 2 } })
    server.push('snapshot', { version: 2 })
    await until(() => c.getState().version === 2)
    expect(server.calls.some((x) => x.url.endsWith('/snapshots/2'))).toBe(true)
    expect(c.peek('checkout_cta', { stableId: 'u1' })).toMatchObject({ reason: 'inactive', variant: 'control' })
  })

  it('parses SSE frames split across chunks', () => {
    const a = parseSse('event: hello\ndata: {"version":1}\n\n: ping\n\nevent: snap')
    expect(a.events).toEqual([{ event: 'hello', data: '{"version":1}' }])
    const b = parseSse(`${a.rest}shot\r\ndata: {"version":2}\r\n\r\n`)
    expect(b.events).toEqual([{ event: 'snapshot', data: '{"version":2}' }])
    expect(b.rest).toBe('')
  })
})

describe('exposure and assignment logging', () => {
  it('logs exposure only for in-experiment evaluations, once per unit per version', async () => {
    const server = fakeServer(snapshot(1))
    const c = client(server, { context: { stableId: 'u1', anonymousId: 'a1' }, logAssignments: false })
    await c.start()
    const e = c.peek('checkout_cta')
    expect(c.logExposure(e)).toBe(true)
    expect(c.logExposure(e)).toBe(false)
    expect(c.logExposure({ ...e, inExperiment: false, reason: 'forced' })).toBe(false)
    expect(c.logExposure(c.peek('nope'))).toBe(false)
    // A new config version is a new exposure.
    expect(c.logExposure({ ...e, version: 2 })).toBe(true)
    await c.flush()
    const sent = server.calls.filter((x) => x.url.endsWith('/events')).flatMap((x) => (x.body as { events: { type: string; flagVersion: number; unitId: string }[] }).events)
    expect(sent.map((s) => [s.type, s.flagVersion, s.unitId])).toEqual([
      ['exposure', 1, 'u1'],
      ['exposure', 2, 'u1'],
    ])
  })

  it('logs assignments from evaluate() but not from peek(), deduped', async () => {
    const server = fakeServer(snapshot(1))
    const c = client(server, { context: { stableId: 'u2' } })
    await c.start()
    c.peek('checkout_cta')
    c.evaluate('checkout_cta')
    c.evaluateAll()
    await c.flush()
    const events = server.calls.filter((x) => x.url.endsWith('/events')).flatMap((x) => (x.body as { events: { type: string }[] }).events)
    expect(events.map((e) => e.type)).toEqual(['assignment'])
  })

  it('keeps the same batch id through retries, and drops on a permanent 4xx', async () => {
    const server = fakeServer(snapshot(1))
    server.eventStatus = [503, 500]
    let now = Date.now()
    const c = client(server, { context: { anonymousId: 'a9' }, now: () => now })
    await c.start()
    c.track('purchase', { value: 30 })
    await c.flush()
    now += 60_000
    await c.flush()
    now += 60_000
    await c.flush()
    const posts = server.calls.filter((x) => x.url.endsWith('/events')).map((x) => x.body as { batchId: string; events: unknown[] })
    expect(posts).toHaveLength(3)
    expect(new Set(posts.map((p) => p.batchId)).size).toBe(1)
    expect(c.getState().queued).toBe(0)

    server.eventStatus = [422]
    c.track('purchase')
    await c.flush()
    expect(c.getState().queued).toBe(0)
  })

  it('persists unsent events and re-sends them with the same batch id after a restart', async () => {
    const storage = memoryStorage()
    const server = fakeServer(snapshot(1))
    server.eventStatus = [503]
    const c1 = client(server, { storage, context: { anonymousId: 'a3' } })
    await c1.start()
    c1.track('purchase')
    await c1.flush()
    const firstBatch = (server.calls.filter((x) => x.url.endsWith('/events'))[0].body as { batchId: string }).batchId
    const c2 = client(server, { storage, context: { anonymousId: 'a3' } })
    await c2.start()
    await c2.flush()
    const batches = server.calls.filter((x) => x.url.endsWith('/events')).map((x) => (x.body as { batchId: string }).batchId)
    expect(batches.filter((b) => b === firstBatch).length).toBeGreaterThanOrEqual(2)
  })

  it('hands unacknowledged batches to the beacon on unload', async () => {
    const beacons: { url: string; body: string }[] = []
    const server = fakeServer(snapshot(1))
    server.down = true
    const c = client(server, { context: { anonymousId: 'a4' }, beacon: (url, body) => (beacons.push({ url, body }), true) })
    await c.start()
    c.track('purchase')
    c.flushOnUnload()
    expect(beacons).toHaveLength(1)
    expect(beacons[0].url).toContain('/events?key=cli_test')
    expect(JSON.parse(beacons[0].body)).toMatchObject({ clientKey: 'cli_test', events: [{ type: 'conversion', name: 'purchase' }] })
  })
})

describe('identity', () => {
  it('keeps bucketing by the anonymous id at sign-in until an alias is given', async () => {
    const c = client(fakeServer(snapshot(1)), { context: { anonymousId: 'anon-7', stableId: 'anon-7' } })
    await c.start()
    const before = c.peek('checkout_cta')
    c.identify({ userId: 'user-7' })
    expect(c.getState().context.stableId).toBe('anon-7')
    expect(c.peek('checkout_cta')).toEqual(before)
    c.identify({ userId: 'user-7', stableId: 'anon-1' })
    expect(c.peek('checkout_cta').unitId).toBe('anon-1')
  })
})
