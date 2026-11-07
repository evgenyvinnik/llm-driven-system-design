import { describe, expect, it } from 'vitest'
import { activeSigningSecrets, computeSignature, parseSignatureHeader, signatureHeader, verifySignature } from './signing.js'

const body = JSON.stringify({ id: 'evt_1', type: 'order.created', data: { amount: 42 } })
const t = 1_800_000_000

describe('signing', () => {
  it('produces t=…,v1=… with one HMAC-SHA256 hex per secret', () => {
    const header = signatureHeader(['whsec_a', 'whsec_b'], t, body)
    const parsed = parseSignatureHeader(header)
    expect(parsed?.timestamp).toBe(t)
    expect(parsed?.signatures).toEqual([computeSignature('whsec_a', t, body), computeSignature('whsec_b', t, body)])
    expect(parsed?.signatures[0]).toMatch(/^[0-9a-f]{64}$/)
  })

  it('verifies with the right secret inside the tolerance window', () => {
    const header = signatureHeader(['whsec_a'], t, body)
    expect(verifySignature(header, body, ['whsec_a'], { nowSeconds: t + 10 })).toMatchObject({ ok: true, matchedSecretIndex: 0 })
  })

  it('rejects a forged signature, a changed body and a missing header', () => {
    const header = signatureHeader(['whsec_a'], t, body)
    expect(verifySignature(header, body, ['whsec_other'], { nowSeconds: t })).toEqual({ ok: false, reason: 'no_matching_signature' })
    expect(verifySignature(header, body.replace('42', '43'), ['whsec_a'], { nowSeconds: t })).toEqual({ ok: false, reason: 'no_matching_signature' })
    expect(verifySignature(undefined, body, ['whsec_a'], { nowSeconds: t })).toEqual({ ok: false, reason: 'missing_header' })
    expect(verifySignature('t=abc,v1=zz', body, ['whsec_a'], { nowSeconds: t })).toEqual({ ok: false, reason: 'malformed_header' })
  })

  it('rejects timestamps outside the replay window in both directions', () => {
    const header = signatureHeader(['whsec_a'], t, body)
    expect(verifySignature(header, body, ['whsec_a'], { nowSeconds: t + 301, toleranceSeconds: 300 })).toEqual({ ok: false, reason: 'timestamp_outside_tolerance' })
    expect(verifySignature(header, body, ['whsec_a'], { nowSeconds: t - 301, toleranceSeconds: 300 })).toEqual({ ok: false, reason: 'timestamp_outside_tolerance' })
  })

  it('a replayed request cannot be refreshed: changing t breaks the signature', () => {
    const header = signatureHeader(['whsec_a'], t, body)
    const refreshed = header.replace(`t=${t}`, `t=${t + 3600}`)
    expect(verifySignature(refreshed, body, ['whsec_a'], { nowSeconds: t + 3600 })).toEqual({ ok: false, reason: 'no_matching_signature' })
  })
})

describe('secret rotation', () => {
  const now = new Date('2026-11-05T12:00:00Z')
  const endpoint = { secretCurrent: 'whsec_new', secretPrevious: 'whsec_old', previousExpiresAt: new Date(now.getTime() + 60_000) }

  it('signs with both secrets during the overlap', () => {
    expect(activeSigningSecrets(endpoint, now)).toEqual(['whsec_new', 'whsec_old'])
    const header = signatureHeader(activeSigningSecrets(endpoint, now), t, body)
    // A receiver that only knows the old secret still verifies, and so does one that has the new one.
    expect(verifySignature(header, body, ['whsec_old'], { nowSeconds: t }).ok).toBe(true)
    expect(verifySignature(header, body, ['whsec_new'], { nowSeconds: t }).ok).toBe(true)
  })

  it('stops sending the old signature after the overlap, so an old-secret-only receiver rejects', () => {
    const later = new Date(now.getTime() + 61_000)
    expect(activeSigningSecrets(endpoint, later)).toEqual(['whsec_new'])
    const header = signatureHeader(activeSigningSecrets(endpoint, later), t, body)
    expect(verifySignature(header, body, ['whsec_old'], { nowSeconds: t })).toEqual({ ok: false, reason: 'no_matching_signature' })
    expect(verifySignature(header, body, ['whsec_new'], { nowSeconds: t }).ok).toBe(true)
  })

  it('no previous secret means one signature', () => {
    expect(activeSigningSecrets({ secretCurrent: 'whsec_x', secretPrevious: null, previousExpiresAt: null }, now)).toEqual(['whsec_x'])
  })
})
