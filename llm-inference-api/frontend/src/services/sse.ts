/**
 * Reads a text/event-stream response with fetch + ReadableStream (so POST
 * bodies and cookies work, unlike EventSource). Calls onEvent per event.
 */
export async function readSse(resp: Response, onEvent: (event: string, data: Record<string, unknown>, id: string | null) => void): Promise<void> {
  if (!resp.body) return
  const reader = resp.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let sep: number
    while ((sep = buffer.indexOf('\n\n')) >= 0) {
      const block = buffer.slice(0, sep)
      buffer = buffer.slice(sep + 2)
      let event = 'message'
      let data = ''
      let id: string | null = null
      for (const line of block.split('\n')) {
        if (line.startsWith('event: ')) event = line.slice(7)
        else if (line.startsWith('data: ')) data += line.slice(6)
        else if (line.startsWith('id: ')) id = line.slice(4)
      }
      if (!data) continue
      try {
        onEvent(event, JSON.parse(data) as Record<string, unknown>, id)
      } catch {
        // ignore malformed events
      }
    }
  }
}
