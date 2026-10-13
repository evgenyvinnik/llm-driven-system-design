/**
 * Server-Sent Events helpers: a writer for Express responses and an incremental
 * parser for consuming an upstream SSE body (the executor reading the model).
 * @module shared/sse
 */
import type { Response } from 'express'

export function openSse(res: Response): void {
  res.status(200)
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
  res.setHeader('Cache-Control', 'no-cache, no-transform')
  res.setHeader('Connection', 'keep-alive')
  // Stops nginx-style proxies from buffering the stream.
  res.setHeader('X-Accel-Buffering', 'no')
  res.flushHeaders()
}

export function writeSse(res: Response, event: string, data: unknown, id?: string): void {
  let frame = ''
  if (id) frame += `id: ${id}\n`
  frame += `event: ${event}\n`
  frame += `data: ${JSON.stringify(data)}\n\n`
  res.write(frame)
}

export function writeSseComment(res: Response, comment: string): void {
  res.write(`: ${comment}\n\n`)
}

export interface SseMessage {
  id?: string
  event: string
  data: string
}

/** Incremental SSE parser: feed decoded text chunks, get complete messages back. */
export class SseParser {
  private buffer = ''

  push(chunk: string): SseMessage[] {
    this.buffer += chunk.replace(/\r\n/g, '\n')
    const messages: SseMessage[] = []
    let boundary = this.buffer.indexOf('\n\n')
    while (boundary !== -1) {
      const block = this.buffer.slice(0, boundary)
      this.buffer = this.buffer.slice(boundary + 2)
      const message = parseBlock(block)
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
  if (data.length === 0) return null
  return { id, event, data: data.join('\n') }
}
