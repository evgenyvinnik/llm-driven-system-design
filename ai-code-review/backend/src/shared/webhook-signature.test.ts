import { describe, expect, it } from 'vitest'
import { signPayload, verifySignature } from './webhook-signature.js'

const SECRET = 'test-secret'
const NOW = 1_800_000_000_000
const T = NOW / 1000
const body = '{"action":"opened"}'
const verify = (header: string | undefined, raw: string | Buffer = body, now = NOW) => verifySignature(header, raw, SECRET, 300, now)

describe('webhook signatures', () => {
  it('accepts a correct signature', () => {
    expect(verify(signPayload(SECRET, T, body))).toEqual({ ok: true, timestamp: T })
  })
  it('verifies raw bytes', () => {
    expect(verify(signPayload(SECRET, T, Buffer.from(body)), Buffer.from(body)).ok).toBe(true)
  })
  it('rejects a missing header', () => {
    expect(verify(undefined)).toEqual({ ok: false, reason: 'missing' })
  })
  it.each(['garbage', 't=abc,v1=def', `t=${T}`, 'v1=' + 'a'.repeat(64), `t=${T},v1=nothex`])('rejects the malformed header %j', (h) => {
    expect(verify(h)).toEqual({ ok: false, reason: 'malformed' })
  })
  it('a present but wrong signature is not enough', () => {
    expect(verify(`t=${T},v1=${'a'.repeat(64)}`)).toEqual({ ok: false, reason: 'bad_signature' })
  })
  it('rejects the wrong secret', () => {
    expect(verify(signPayload('other', T, body))).toEqual({ ok: false, reason: 'bad_signature' })
  })
  it('rejects a changed body', () => {
    expect(verify(signPayload(SECRET, T, body), body.replace('opened', 'closed'))).toEqual({ ok: false, reason: 'bad_signature' })
  })
  it('rejects re-stamping an old signature with a new timestamp', () => {
    const old = signPayload(SECRET, T - 10_000, body).split('v1=')[1]
    expect(verify(`t=${T},v1=${old}`)).toEqual({ ok: false, reason: 'bad_signature' })
  })
  it('rejects a correctly signed but old delivery as a replay', () => {
    expect(verify(signPayload(SECRET, T - 301, body))).toEqual({ ok: false, reason: 'replay' })
  })
  it('rejects a far-future timestamp', () => {
    expect(verify(signPayload(SECRET, T + 301, body))).toEqual({ ok: false, reason: 'replay' })
  })
  it('accepts inside the window', () => {
    expect(verify(signPayload(SECRET, T - 299, body)).ok).toBe(true)
  })
})
