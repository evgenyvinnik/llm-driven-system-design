import { describe, expect, it } from 'vitest'
import { ALL_TOOLS, toolsFor, toApiTools, toolsetHash } from './registry.js'
import { shrink } from './shrink.js'
import { validateArgs } from './validate.js'

describe('validateArgs', () => {
  const search = ALL_TOOLS.find((t) => t.name === 'search_mail')!
  it('applies defaults and accepts valid arguments', () => {
    const args: Record<string, unknown> = { query: 'budget' }
    expect(validateArgs(search.name, search.inputSchema, args)).toEqual([])
    expect(args.limit).toBe(8)
  })
  it('explains what is wrong in words the model can act on', () => {
    expect(validateArgs(search.name, search.inputSchema, { after: 'last week', verbose: true })).toEqual(
      expect.arrayContaining(['missing required argument `query`', '`after` must be a date like 2026-11-03', 'unknown argument `verbose`']),
    )
  })
})

describe('registry', () => {
  it('only offers tools that fit the app and the settings', () => {
    const names = (app: 'mail' | 'docs' | 'calendar', allow_send = true, allow_doc_edits = true) => toolsFor(app, { allow_send, allow_doc_edits }).map((t) => t.name)
    expect(names('docs')).toContain('insert_text')
    expect(names('mail')).not.toContain('insert_text')
    expect(names('mail', false)).not.toContain('send_draft')
    expect(names('docs', true, false)).not.toContain('replace_text')
  })
  it('keeps definitions stable for caching, with one breakpoint on the last tool', () => {
    const tools = toolsFor('mail', { allow_send: true, allow_doc_edits: true })
    const api = toApiTools(tools) as { cache_control?: unknown }[]
    expect(api.filter((t) => t.cache_control)).toHaveLength(1)
    expect(api[api.length - 1].cache_control).toBeDefined()
    expect(toolsetHash(tools)).toBe(toolsetHash([...tools]))
  })
})

describe('shrink', () => {
  it('trims long lists from the end, keeps ids, and says what was left out', () => {
    const results = Array.from({ length: 40 }, (_, i) => ({ message_id: `m_${i}`, snippet: 'y'.repeat(300) }))
    const { content, trimmed } = shrink({ results }, 1000)
    expect(trimmed).toBe(true)
    const kept = content.results as { message_id: string }[]
    expect(kept.length).toBeLessThan(40)
    expect(kept[0].message_id).toBe('m_0')
    expect(content.results_omitted).toMatch(/more not shown/)
  })
})
