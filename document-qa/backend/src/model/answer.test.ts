import request from 'supertest'
import { describe, expect, it } from 'vitest'
import { createModelApp, defaultModelSettings } from './app.js'
import { composeAnswer, NOT_FOUND, parsePrompt } from './answer.js'

const prompt = `<sources>
<source id="1" title="Expense policy" version="1"># Submitting a claim

Submit expense claims in the finance portal within 30 days of the purchase. Attach an itemized receipt for every expense over 25 dollars.</source>
<source id="2" title="Runbook" version="1">The primary on-call engineer must acknowledge a page within 5 minutes.</source>
</sources>

Question: How many days do I have to submit expense claims?`

describe('mock model answer', () => {
  it('parses numbered sources and the question', () => {
    const p = parsePrompt(prompt)
    expect(p.sources.map((s) => s.id)).toEqual([1, 2])
    expect(p.question).toBe('How many days do I have to submit expense claims?')
  })

  it('answers extractively with the cited sentence and its marker', () => {
    const a = composeAnswer(parsePrompt(prompt))
    expect(a).toContain('Submit expense claims in the finance portal within 30 days of the purchase. [1]')
    expect(a).not.toContain('[2]')
  })

  it('says not found when nothing relevant was retrieved', () => {
    expect(composeAnswer(parsePrompt('<sources>\n</sources>\n\nQuestion: What is the Q3 marketing budget?'))).toBe(NOT_FOUND)
    expect(composeAnswer(parsePrompt(prompt.replace(/Question:.*$/, 'Question: What is the parental leave policy in Brazil?')))).toBe(NOT_FOUND)
  })

  it('is deterministic', () => {
    expect(composeAnswer(parsePrompt(prompt))).toBe(composeAnswer(parsePrompt(prompt)))
  })
})

describe('mock model service', () => {
  const body = { model: 'mock', max_tokens: 200, stream: true, messages: [{ role: 'user', content: prompt }] }

  it('streams Messages API events ending in message_stop', async () => {
    const app = createModelApp({ ...defaultModelSettings(), ttftMs: 0, tokensPerSecond: 5000 })
    const res = await request(app).post('/v1/messages').send(body)
    expect(res.status).toBe(200)
    expect(res.text).toContain('event: message_start')
    expect(res.text).toContain('event: content_block_delta')
    expect(res.text.trim().endsWith('data: {"type":"message_stop"}')).toBe(true)
  })

  it('returns 529 when an overload is armed', async () => {
    const app = createModelApp({ ...defaultModelSettings(), ttftMs: 0, armed: { overloaded: 1, server_error: 0, midstream_disconnect: 0 } })
    expect((await request(app).post('/v1/messages').send(body)).status).toBe(529)
  })

  it('drops the connection mid-stream when armed, without message_stop', async () => {
    const app = createModelApp({ ...defaultModelSettings(), ttftMs: 0, tokensPerSecond: 5000, disconnectAfterTokens: 3, armed: { overloaded: 0, server_error: 0, midstream_disconnect: 1 } })
    const res = await request(app)
      .post('/v1/messages')
      .send(body)
      .then(
        (r) => r.text,
        (err: Error) => `ERR ${err.message}`,
      )
    expect(res).not.toContain('message_stop')
  })
})
