import { describe, expect, it } from 'vitest'
import { SseParser } from './sse.js'

describe('SseParser', () => {
  it('parses messages split across arbitrary chunk boundaries', () => {
    const parser = new SseParser()
    const raw = 'id: 1-0\nevent: delta\ndata: {"text":"he"}\n\n: ping\n\nevent: end\ndata: {}\n\n'
    const messages = []
    for (const char of raw) messages.push(...parser.push(char))
    expect(messages).toEqual([
      { id: '1-0', event: 'delta', data: '{"text":"he"}' },
      { id: undefined, event: 'end', data: '{}' },
    ])
  })

  it('joins multi-line data and normalizes CRLF', () => {
    const parser = new SseParser()
    expect(parser.push('data: a\r\ndata: b\r\n\r\n')).toEqual([{ id: undefined, event: 'message', data: 'a\nb' }])
  })
})
