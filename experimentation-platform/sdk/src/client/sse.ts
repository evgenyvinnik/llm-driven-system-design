/**
 * Server-Sent Events over fetch + ReadableStream instead of EventSource:
 * it works the same in browsers and Node, can send the client key as a header,
 * and lets the SDK run its own reconnect and heartbeat watchdog.
 * @module client/sse
 */

export interface SseEvent {
  event: string
  data: string
}

/** Splits complete events off the front of a buffer; returns the incomplete rest. */
export function parseSse(buffer: string): { events: SseEvent[]; rest: string } {
  const normalized = buffer.replace(/\r\n/g, '\n')
  const blocks = normalized.split('\n\n')
  const rest = blocks.pop() ?? ''
  const events: SseEvent[] = []
  for (const block of blocks) {
    let event = 'message'
    const data: string[] = []
    for (const line of block.split('\n')) {
      if (line === '' || line.startsWith(':')) continue
      const i = line.indexOf(':')
      const field = i < 0 ? line : line.slice(0, i)
      const value = i < 0 ? '' : line.slice(i + 1).replace(/^ /, '')
      if (field === 'event') event = value
      else if (field === 'data') data.push(value)
    }
    if (data.length > 0) events.push({ event, data: data.join('\n') })
  }
  return { events, rest }
}

export interface StreamHandlers {
  onOpen(): void
  onEvent(e: SseEvent): void
}

/**
 * Reads one SSE connection until it ends, errors, or goes silent for longer
 * than `idleTimeoutMs` (the server sends a comment ping every 15 s, so silence
 * means a half-open connection). Resolves when the stream ends; rejects on error.
 */
export async function readStream(
  fetchImpl: typeof fetch,
  url: string,
  headers: Record<string, string>,
  handlers: StreamHandlers,
  signal: AbortSignal,
  idleTimeoutMs: number,
): Promise<void> {
  const idle = new AbortController()
  const onAbort = () => idle.abort()
  signal.addEventListener('abort', onAbort)
  let watchdog: ReturnType<typeof setTimeout> | undefined
  const arm = () => {
    if (watchdog) clearTimeout(watchdog)
    watchdog = setTimeout(() => idle.abort(), idleTimeoutMs)
  }
  try {
    arm()
    const res = await fetchImpl(url, { headers: { ...headers, Accept: 'text/event-stream' }, signal: idle.signal })
    if (!res.ok || !res.body) throw new Error(`stream HTTP ${res.status}`)
    handlers.onOpen()
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    for (;;) {
      const { value, done } = await reader.read()
      if (done) return
      arm()
      buffer += decoder.decode(value, { stream: true })
      const parsed = parseSse(buffer)
      buffer = parsed.rest
      for (const e of parsed.events) handlers.onEvent(e)
    }
  } finally {
    if (watchdog) clearTimeout(watchdog)
    signal.removeEventListener('abort', onAbort)
  }
}
