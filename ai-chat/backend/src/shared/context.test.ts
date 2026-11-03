import { describe, expect, it } from 'vitest'
import { buildContext, titleFromMessage, type ContextMessage } from './context.js'

const msg = (role: 'user' | 'assistant', chars: number, tag = ''): ContextMessage => ({
  role,
  content: `${tag}${'x'.repeat(Math.max(0, chars - tag.length))}`,
})

describe('buildContext', () => {
  it('keeps everything that fits, oldest first', () => {
    const path = [msg('user', 40, 'a'), msg('assistant', 40, 'b'), msg('user', 40, 'c')]
    const ctx = buildContext(path, 100)
    expect(ctx.messages.map((m) => m.content[0])).toEqual(['a', 'b', 'c'])
    expect(ctx.dropped).toBe(0)
    expect(ctx.inputTokens).toBe(30)
  })

  it('drops the oldest messages first when over budget', () => {
    const path = [msg('user', 400, 'a'), msg('assistant', 400, 'b'), msg('user', 40, 'c')]
    const ctx = buildContext(path, 120)
    expect(ctx.messages.map((m) => m.content[0])).toEqual(['b', 'c'])
    expect(ctx.dropped).toBe(1)
  })

  it('always keeps the message being answered, trimmed to the budget', () => {
    const ctx = buildContext([msg('user', 4000, 'z')], 100)
    expect(ctx.messages).toHaveLength(1)
    expect(ctx.messages[0].content.length).toBe(400)
  })

  it('skips assistant messages that ended with no output', () => {
    const path = [msg('user', 20, 'a'), { role: 'assistant' as const, content: '' }, msg('user', 20, 'c')]
    expect(buildContext(path, 100).messages.map((m) => m.content[0])).toEqual(['a', 'c'])
  })
})

describe('titleFromMessage', () => {
  it('cuts long messages at a word boundary', () => {
    expect(titleFromMessage('Help me plan a three day trip to the mountains with two kids and a dog')).toBe(
      'Help me plan a three day trip to the mountains…',
    )
  })

  it('collapses whitespace and handles empty input', () => {
    expect(titleFromMessage('  hello \n world ')).toBe('hello world')
    expect(titleFromMessage('   ')).toBe('New chat')
  })
})
