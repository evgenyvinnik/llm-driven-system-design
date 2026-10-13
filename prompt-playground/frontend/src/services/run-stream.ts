/**
 * Follows one run's event stream with automatic resume.
 *
 * Uses fetch rather than EventSource so the request carries the session
 * cookie under our control and can send Last-Event-ID explicitly. After a
 * dropped connection it reconnects with backoff from the last event it saw,
 * so no output is lost or duplicated, and it never creates a new run: the
 * run already exists on the server and is just being re-read.
 */
import { SseParser } from '@/lib/sse'

export type ConnectionState = 'connecting' | 'open' | 'reconnecting' | 'closed'

export interface StreamCallbacks {
  onEvent: (type: string, data: unknown, id: string | undefined) => void
  onConnection: (state: ConnectionState) => void
  /** Called once when the stream cannot continue (e.g. the run is not visible to this user). */
  onFatal: (message: string) => void
}

const BACKOFF_MS = [500, 1000, 2000, 4000, 8000]

export function followRun(runId: string, lastEventId: string | undefined, callbacks: StreamCallbacks): () => void {
  const controller = new AbortController()
  let cursor = lastEventId
  let finished = false

  async function loop() {
    let failures = 0
    while (!finished && !controller.signal.aborted) {
      callbacks.onConnection(failures === 0 ? 'connecting' : 'reconnecting')
      try {
        const response = await fetch(`/api/v1/runs/${runId}/events`, {
          headers: cursor ? { 'Last-Event-ID': cursor, Accept: 'text/event-stream' } : { Accept: 'text/event-stream' },
          credentials: 'same-origin',
          signal: controller.signal,
        })
        if (response.status === 401 || response.status === 404) {
          finished = true
          callbacks.onFatal(response.status === 401 ? 'Signed out' : 'Run not found')
          break
        }
        if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`)
        callbacks.onConnection('open')
        const reader = response.body.getReader()
        const decoder = new TextDecoder()
        const parser = new SseParser()
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          for (const message of parser.push(decoder.decode(value, { stream: true }))) {
            failures = 0
            if (message.id) cursor = message.id
            callbacks.onEvent(message.event, JSON.parse(message.data), message.id)
            if (message.event === 'end' || message.event === 'snapshot') finished = true
          }
        }
      } catch (err) {
        if (controller.signal.aborted) break
        void err
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
