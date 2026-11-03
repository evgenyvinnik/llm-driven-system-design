/**
 * Follows one turn's event stream with automatic resume.
 *
 * fetch rather than EventSource, so the request carries the session cookie
 * and an explicit Last-Event-ID. After a dropped connection it reconnects
 * with backoff from the last event it saw, so text is never lost or
 * repeated, and it never starts a new turn: the turn already exists on the
 * server and is only being re-read, possibly from another API instance.
 */
import { SseParser } from '@/lib/sse'

export type ConnectionState = 'connecting' | 'open' | 'reconnecting' | 'closed'

export interface StreamCallbacks {
  onEvents: (events: { type: string; data: Record<string, unknown>; id?: string }[]) => void
  onConnection: (state: ConnectionState) => void
}

const BACKOFF_MS = [500, 1000, 2000, 4000, 8000]

export function followTurn(turnId: string, lastEventId: string | undefined, callbacks: StreamCallbacks): () => void {
  const controller = new AbortController()
  let cursor = lastEventId
  let finished = false

  async function loop() {
    let failures = 0
    while (!finished && !controller.signal.aborted) {
      callbacks.onConnection(failures === 0 ? 'connecting' : 'reconnecting')
      try {
        const response = await fetch(`/api/v1/assistant/turns/${turnId}/events`, {
          headers: { Accept: 'text/event-stream', ...(cursor ? { 'Last-Event-ID': cursor } : {}) },
          credentials: 'same-origin',
          signal: controller.signal,
        })
        if (response.status === 401 || response.status === 404) break
        if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`)
        callbacks.onConnection('open')
        const reader = response.body.getReader()
        const decoder = new TextDecoder()
        const parser = new SseParser()
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          const batch = parser.push(decoder.decode(value, { stream: true })).map((m) => {
            failures = 0
            if (m.id) cursor = m.id
            if (m.event === 'turn.end' || m.event === 'snapshot') finished = true
            return { type: m.event, data: JSON.parse(m.data) as Record<string, unknown>, id: m.id }
          })
          // A replay can deliver many events in one chunk; they're applied together.
          if (batch.length) callbacks.onEvents(batch)
        }
      } catch {
        if (controller.signal.aborted) break
      }
      if (finished || controller.signal.aborted) break
      const delay = BACKOFF_MS[Math.min(failures, BACKOFF_MS.length - 1)]
      failures++
      await new Promise((resolve) => setTimeout(resolve, delay))
    }
    callbacks.onConnection('closed')
  }

  void loop()
  return () => controller.abort()
}
