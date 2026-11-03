/** Incremental Server-Sent Events parser for fetch-based streams. */
export interface SseMessage {
  id?: string
  event: string
  data: string
}

export class SseParser {
  private buffer = ''

  push(chunk: string): SseMessage[] {
    this.buffer += chunk.replace(/\r\n/g, '\n')
    const messages: SseMessage[] = []
    let boundary = this.buffer.indexOf('\n\n')
    while (boundary !== -1) {
      const message = parseBlock(this.buffer.slice(0, boundary))
      this.buffer = this.buffer.slice(boundary + 2)
      if (message) messages.push(message)
      boundary = this.buffer.indexOf('\n\n')
    }
    return messages
  }
}

function parseBlock(block: string): SseMessage | null {
  let event = 'message'
  let id: string | undefined
  const data: string[] = []
  for (const line of block.split('\n')) {
    if (line === '' || line.startsWith(':')) continue
    const colon = line.indexOf(':')
    const field = colon === -1 ? line : line.slice(0, colon)
    let value = colon === -1 ? '' : line.slice(colon + 1)
    if (value.startsWith(' ')) value = value.slice(1)
    if (field === 'event') event = value
    else if (field === 'data') data.push(value)
    else if (field === 'id') id = value
  }
  return data.length > 0 ? { id, event, data: data.join('\n') } : null
}
