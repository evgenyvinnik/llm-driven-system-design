/**
 * Reads an answer run's SSE stream with fetch + ReadableStream (cookies and
 * Last-Event-ID work, unlike EventSource with custom headers). On a network
 * error, or a stream that closes before a terminal event, it reconnects with
 * the last event id it saw, so the server replays only what was missed; any
 * API instance can serve the reconnect.
 */
import { SseParser } from '@/lib/sse'

export interface StreamEvent {
  id?: string
  type: string
  data: Record<string, unknown>
}

const TERMINAL = new Set(['completed', 'failed', 'cancelled'])

/** A 4xx (signed out, run not yours or gone) will not get better by retrying. */
class StreamRejected extends Error {}
const MAX_TRIES = 5

export async function followRun(runId: string, onEvent: (e: StreamEvent) => void, signal: AbortSignal): Promise<void> {
  let lastId: string | undefined
  let tries = 0
  while (!signal.aborted) {
    let ended = false
    try {
      const res = await fetch(`/api/v1/answers/${runId}/stream`, {
        credentials: 'same-origin',
        headers: { Accept: 'text/event-stream', ...(lastId ? { 'Last-Event-ID': lastId } : {}) },
        signal,
      })
      if (res.status >= 400 && res.status < 500) throw new StreamRejected(`stream returned ${res.status}`)
      if (!res.ok || !res.body) throw new Error(`stream returned ${res.status}`)
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      const parser = new SseParser()
      while (!ended) {
        const { value, done } = await reader.read()
        if (done) break
        for (const msg of parser.push(decoder.decode(value, { stream: true }))) {
          if (msg.id) lastId = msg.id
          tries = 0
          let data: Record<string, unknown> = {}
          try {
            data = JSON.parse(msg.data) as Record<string, unknown>
          } catch {
            // ignore malformed frames
          }
          onEvent({ id: msg.id, type: msg.event, data })
          if (TERMINAL.has(msg.event)) ended = true
        }
      }
      if (ended) return
    } catch (err) {
      if (signal.aborted) return
      if (err instanceof StreamRejected) throw err
    }
    tries += 1
    if (tries > MAX_TRIES) throw new Error('lost the answer stream; reload to see the final result')
    await new Promise((r) => setTimeout(r, 400 * 2 ** (tries - 1)))
  }
}
