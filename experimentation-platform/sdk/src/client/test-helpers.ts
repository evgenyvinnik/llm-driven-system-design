/** Test doubles: a snapshot builder and a scriptable fake SDK server (fetch). */
import type { Snapshot, SnapshotFlag } from '../core/types.js'

export function snapshot(version: number, flags: Partial<Record<string, Partial<SnapshotFlag>>> = {}, environment = 'prod'): Snapshot {
  const base: SnapshotFlag = {
    key: 'checkout_cta',
    kind: 'experiment',
    unitType: 'user',
    salt: 'cta',
    status: 'running',
    version: 1,
    variants: [
      { key: 'control', name: 'Control', value: 'Add to cart' },
      { key: 'treatment', name: 'Treatment', value: 'Buy now' },
    ],
    defaultVariant: 'control',
    rules: [],
    fallthrough: 'enroll',
    allocation: { control: [[0, 5000]], treatment: [[5000, 10_000]] },
  }
  const out: Record<string, SnapshotFlag> = {}
  for (const [key, f] of Object.entries(flags)) out[key] = { ...base, key, ...f }
  if (Object.keys(flags).length === 0) out.checkout_cta = base
  return { schema: 1, environment, version, compiledAt: new Date(0).toISOString(), flags: out }
}

export interface FakeServer {
  fetch: typeof fetch
  calls: { url: string; method: string; headers: Record<string, string>; body: unknown }[]
  current: Snapshot | null
  down: boolean
  eventStatus: number[]
  /** Push an SSE event to every open stream. */
  push(event: string, data: unknown): void
  streams: number
}

export function fakeServer(initial: Snapshot | null): FakeServer {
  const controllers = new Set<ReadableStreamDefaultController<Uint8Array>>()
  const encoder = new TextEncoder()
  const server: FakeServer = {
    calls: [],
    current: initial,
    down: false,
    eventStatus: [],
    streams: 0,
    push(event, data) {
      for (const c of controllers) c.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`))
    },
    fetch: (async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = String(input)
      const headers = (init.headers ?? {}) as Record<string, string>
      server.calls.push({ url, method: init.method ?? 'GET', headers, body: init.body ? JSON.parse(String(init.body)) : undefined })
      if (server.down) throw new TypeError('fetch failed')
      const path = new URL(url, 'http://sdk.test').pathname
      if (path.endsWith('/stream')) {
        let ctrl!: ReadableStreamDefaultController<Uint8Array>
        const body = new ReadableStream<Uint8Array>({
          start(c) {
            ctrl = c
            controllers.add(c)
            server.streams++
            c.enqueue(encoder.encode(`event: hello\ndata: ${JSON.stringify({ version: server.current?.version ?? 0 })}\n\n`))
          },
          cancel() {
            controllers.delete(ctrl)
            server.streams--
          },
        })
        init.signal?.addEventListener('abort', () => {
          if (controllers.delete(ctrl)) {
            server.streams--
            try {
              ctrl.error(new Error('aborted'))
            } catch {
              // already closed
            }
          }
        })
        return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
      }
      if (path.endsWith('/events')) {
        const status = server.eventStatus.shift() ?? 202
        return new Response(JSON.stringify({ accepted: 1 }), { status })
      }
      if (path.endsWith('/clients/report')) return new Response('{}', { status: 200 })
      const byVersion = path.match(/\/snapshots\/(\d+)$/)
      if (path.endsWith('/snapshot') || byVersion) {
        const snap = server.current
        if (!snap) return new Response('{}', { status: 503 })
        const etag = `"${snap.environment}-v${snap.version}"`
        if (headers['If-None-Match'] === etag) return new Response(null, { status: 304, headers: { ETag: etag } })
        return new Response(JSON.stringify(snap), { status: 200, headers: { ETag: etag } })
      }
      return new Response('{}', { status: 404 })
    }) as typeof fetch,
  }
  return server
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export async function until(cond: () => boolean, timeoutMs = 2_000): Promise<void> {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('condition not met in time')
    await sleep(5)
  }
}
