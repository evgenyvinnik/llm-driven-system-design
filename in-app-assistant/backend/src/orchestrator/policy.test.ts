import { describe, expect, it } from 'vitest'
import { decide } from './policy.js'
import { createDraft, getMessage, sendDraft } from '../tools/mail.js'
import { insertText } from '../tools/docs.js'
import { createEvent } from '../tools/calendar.js'

const settings = { confirm_writes: false, block_external_after_untrusted: false }
const facts = (external: string[] = []) => ({ externalRecipients: external, title: 't', preview: {} })

describe('policy engine', () => {
  it('allows reads', () => {
    expect(decide({ tool: getMessage, args: {}, facts: null, tainted: true, settings }).action).toBe('allow')
  })

  it('allows reversible writes and asks for irreversible ones', () => {
    expect(decide({ tool: insertText, args: { mode: 'tracked' }, facts: facts(), tainted: false, settings }).action).toBe('allow')
    const direct = decide({ tool: insertText, args: { mode: 'direct' }, facts: facts(), tainted: false, settings })
    expect(direct).toMatchObject({ action: 'confirm', rule: 'irreversible-write' })
  })

  it('always confirms sends', () => {
    expect(decide({ tool: sendDraft, args: {}, facts: facts(), tainted: false, settings })).toMatchObject({ action: 'confirm', rule: 'send' })
  })

  it('flags external sends after untrusted content, and blocks them when the setting says so', () => {
    const tainted = decide({ tool: sendDraft, args: {}, facts: facts(['x@evil.example']), tainted: true, settings })
    expect(tainted).toMatchObject({ action: 'confirm', rule: 'untrusted-external-send' })
    const blocked = decide({ tool: sendDraft, args: {}, facts: facts(['x@evil.example']), tainted: true, settings: { ...settings, block_external_after_untrusted: true } })
    expect(blocked.action).toBe('deny')
    expect(blocked.reason).toMatch(/Blocked by policy/)
  })

  it('drafts stay allowed even when tainted: nothing leaves until send_draft', () => {
    expect(decide({ tool: createDraft, args: {}, facts: facts(['x@evil.example']), tainted: true, settings }).action).toBe('allow')
  })

  it('treats an event with attendees as a send, and one without as a write', () => {
    expect(decide({ tool: createEvent, args: { attendees: ['raj@lumenlabs.example'] }, facts: facts(), tainted: false, settings }).action).toBe('confirm')
    expect(decide({ tool: createEvent, args: {}, facts: facts(), tainted: false, settings }).action).toBe('allow')
  })

  it('honours confirm-every-change', () => {
    expect(decide({ tool: createDraft, args: {}, facts: facts(), tainted: false, settings: { ...settings, confirm_writes: true } }).rule).toBe('confirm-every-change')
  })
})
