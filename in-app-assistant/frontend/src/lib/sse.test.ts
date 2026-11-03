import { describe, expect, it } from 'vitest'
import { SseParser } from './sse'

describe('SseParser', () => {
  it('handles chunk boundaries anywhere, including inside a field', () => {
    const parser = new SseParser()
    const out = [
      ...parser.push('id: 17-0\nevent: del'),
      ...parser.push('ta\ndata: {"text":"a b"}\n'),
      ...parser.push('\n: ping\n\n'),
    ]
    expect(out).toEqual([{ id: '17-0', event: 'delta', data: '{"text":"a b"}' }])
  })
})
