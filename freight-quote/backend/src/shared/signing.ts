/**
 * Webhook signatures: HMAC-SHA256 over "<unix seconds>.<raw body>" with the
 * customer's webhook secret, sent as `X-FQ-Signature: t=<ts>,v1=<hex>`. The
 * timestamp bounds replay; the receiver deduplicates by X-FQ-Event-Id because
 * delivery is at-least-once.
 * @module shared/signing
 */
import { createHmac, timingSafeEqual } from 'node:crypto'

export function signPayload(secret: string, body: string, timestampSeconds: number): string {
  const mac = createHmac('sha256', secret).update(`${timestampSeconds}.${body}`).digest('hex')
  return `t=${timestampSeconds},v1=${mac}`
}

export type VerifyResult = { ok: true } | { ok: false; reason: 'malformed' | 'expired' | 'mismatch' }

export function verifySignature(secret: string, body: string, header: string | undefined, nowSeconds: number, toleranceSeconds = 300): VerifyResult {
  if (!header) return { ok: false, reason: 'malformed' }
  const parts = Object.fromEntries(header.split(',').map((kv) => kv.split('=') as [string, string]))
  const ts = Number(parts.t)
  if (!Number.isFinite(ts) || !parts.v1) return { ok: false, reason: 'malformed' }
  if (Math.abs(nowSeconds - ts) > toleranceSeconds) return { ok: false, reason: 'expired' }
  const expected = createHmac('sha256', secret).update(`${ts}.${body}`).digest()
  const given = Buffer.from(parts.v1, 'hex')
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return { ok: false, reason: 'mismatch' }
  return { ok: true }
}
