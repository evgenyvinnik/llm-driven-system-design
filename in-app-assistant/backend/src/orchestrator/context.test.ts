import { describe, expect, it } from 'vitest'
import { assembleHistory, compactTurn, verifyCitations } from './context.js'
import type { MessageParam } from './model-client.js'

const userText = (text: string): MessageParam => ({ role: 'user', content: [{ type: 'text', text }] })
const assistant = (text: string, thinking = false): MessageParam => ({
  role: 'assistant',
  content: [...(thinking ? [{ type: 'thinking' as const, thinking: '', signature: 'sig' }] : []), { type: 'text' as const, text }],
})

describe('verifyCitations', () => {
  const sources = {
    m_off1: { id: 'm_off1', kind: 'mail' as const, title: 'Budget', href: '/mail?m=m_off1' },
    doc_offsite: { id: 'doc_offsite', kind: 'doc' as const, title: 'Plan', href: '/docs/doc_offsite' },
  }
  it('marks retrieved ids verified and invented ones not', () => {
    const out = verifyCitations('A [m_off1]. B [m_fake9]. C [m_off1].', sources)
    expect(out).toEqual([
      expect.objectContaining({ id: 'm_off1', verified: true }),
      { id: 'm_fake9', verified: false },
    ])
  })
  it('resolves a paragraph citation against its document and links to the paragraph', () => {
    const [c] = verifyCitations('See [doc_offsite#p_8].', sources)
    expect(c.verified).toBe(true)
    expect(c.source?.href).toBe('/docs/doc_offsite?p=p_8')
  })
})

describe('compactTurn', () => {
  const big = 'x'.repeat(4000)
  const round = (id: string): MessageParam => ({ role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: `{"message_id":"m_${id}","body":"${big}"}` }] })
  it('stubs older tool results but keeps the last two rounds and the ids', () => {
    const messages = [userText('q'), assistant('a'), round('a1'), assistant('b'), round('b2'), assistant('c'), round('c3')]
    const { messages: out, removed } = compactTurn(messages, 0, 2500)
    expect(removed).toBe(1)
    const first = (out[2].content as { content: string }[])[0].content
    expect(first).toMatch(/Earlier result removed/)
    expect(first).toMatch(/m_a1/)
    expect(JSON.stringify(out[6])).toContain(big)
  })
  it('leaves a request that fits alone', () => {
    const messages = [userText('q')]
    expect(compactTurn(messages, 0, 10_000)).toEqual({ messages, removed: 0 })
  })
})

describe('assembleHistory', () => {
  const turn = (text: string, thinking = false) => ({
    messages: [userText(`<user_request>\n${text}\n</user_request>`), assistant(`answer to ${text}`, thinking)],
    status: 'completed' as const,
    user_text: text,
    final_text: `answer to ${text}`,
    tainted: false,
    toolset_hash: 'h1',
    sources: {},
  })
  it('keeps recent turns verbatim, including thinking blocks, when nothing was rewritten', () => {
    const h = assembleHistory([turn('one', true)], 10_000, 'h1')
    expect(h.summarized).toBe(0)
    expect(JSON.stringify(h.messages)).toContain('"thinking"')
  })
  it('folds older turns into a summary and strips thinking from the kept ones', () => {
    const turns = [turn('one'), turn('two'), turn('three'.repeat(200), true)]
    const h = assembleHistory(turns, 300, 'h1')
    expect(h.summarized).toBeGreaterThan(0)
    expect(JSON.stringify(h.messages[0])).toContain('<earlier_conversation>')
    expect(JSON.stringify(h.messages)).not.toContain('"thinking"')
  })
  it('carries taint forward from earlier turns', () => {
    expect(assembleHistory([{ ...turn('one'), tainted: true }], 10_000, 'h1').tainted).toBe(true)
  })
  it('renders a cancelled turn as a note, never its half-finished tool calls', () => {
    const cancelled = { ...turn('one'), status: 'cancelled' as const }
    const h = assembleHistory([cancelled], 10_000, 'h1')
    expect(JSON.stringify(h.messages[1])).toContain('stopped this request')
  })
})
