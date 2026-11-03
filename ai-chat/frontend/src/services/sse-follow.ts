/**
 * Follows an SSE endpoint over fetch with automatic resume.
 *
 * fetch rather than EventSource, so the request carries the session cookie
 * under our control and can send Last-Event-ID explicitly (EventSource only
 * sends it on its own reconnects, never on the first request, so it can't
 * resume from a checkpoint loaded over REST). After a dropped connection it
 * reconnects with backoff from the last event ID it saw, so nothing is lost
 * or duplicated, and it never creates anything on the server: the resource
 * already exists and is just being re-read.
 */
import { SseParser } from '@/lib/sse'

export type ConnectionState = 'connecting' | 'open' | 'reconnecting' | 'closed'

export interface FollowOptions {
  url: string
  lastEventId?: string | null
  onEvent: (type: string, data: unknown, id: string | undefined) => void
  onConnection?: (state: ConnectionState) => void
  /** Called once when the stream cannot continue (signed out, or not visible to this user). */
  onFatal?: (status: number) => void
  /** Return true for events after which the stream is complete and must not reconnect. */
  isFinal?: (type: string) => boolean
}

const BACKOFF_MS = [500, 1000, 2000, 4000, 8000]

export function followSse(opts: FollowOptions): () => void {
  const controller = new AbortController()
  let cursor = opts.lastEventId ?? undefined
  let finished = false

  async function loop() {
    let failures = 0
    while (!finished && !controller.signal.aborted) {
      opts.onConnection?.(failures === 0 ? 'connecting' : 'reconnecting')
      try {
        const response = await fetch(opts.url, {
          headers: cursor ? { 'Last-Event-ID': cursor, Accept: 'text/event-stream' } : { Accept: 'text/event-stream' },
          credentials: 'same-origin',
          signal: controller.signal,
        })
        if (response.status === 401 || response.status === 404) {
          finished = true
          opts.onFatal?.(response.status)
          break
        }
        if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`)
        opts.onConnection?.('open')
        const reader = response.body.getReader()
        const decoder = new TextDecoder()
        const parser = new SseParser()
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          for (const message of parser.push(decoder.decode(value, { stream: true }))) {
            failures = 0
            if (message.id) cursor = message.id
            opts.onEvent(message.event, JSON.parse(message.data), message.id)
            if (opts.isFinal?.(message.event)) finished = true
          }
        }
      } catch {
        if (controller.signal.aborted) break
      }
      if (finished || controller.signal.aborted) break
      const delay = BACKOFF_MS[Math.min(failures, BACKOFF_MS.length - 1)]
      failures++
      await new Promise((resolve) => setTimeout(resolve, delay))
    }
    opts.onConnection?.('closed')
  }

  void loop()
  return () => controller.abort()
}
