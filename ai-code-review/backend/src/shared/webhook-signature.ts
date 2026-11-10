/**
 * Webhook signatures: HMAC-SHA256 over `timestamp.rawBody`. Signing the
 * timestamp is what makes a replay window meaningful, since a captured request
 * cannot be re-stamped without the secret. The comparison is constant-time and
 * covers the raw bytes, never re-serialized JSON.
 * @module shared/webhook-signature
 */
import { createHmac, timingSafeEqual } from 'node:crypto'

export function signPayload(secret: string, timestamp: number, rawBody: string | Buffer): string {
  const mac = createHmac('sha256', secret)
  mac.update(`${timestamp}.`)
  mac.update(rawBody)
  return `t=${timestamp},v1=${mac.digest('hex')}`
}

export type VerifyResult = { ok: true; timestamp: number } | { ok: false; reason: 'missing' | 'malformed' | 'bad_signature' | 'replay' }

export function verifySignature(
  header: string | undefined,
  rawBody: Buffer | string,
  secret: string,
  toleranceSeconds: number,
  now: number = Date.now(),
): VerifyResult {
  if (!header) return { ok: false, reason: 'missing' }
  const parts = Object.fromEntries(header.split(',').map((p) => p.split('=', 2) as [string, string]))
  const timestamp = Number.parseInt(parts.t ?? '', 10)
  const provided = parts.v1
  if (!Number.isFinite(timestamp) || !provided || !/^[0-9a-f]{64}$/.test(provided)) return { ok: false, reason: 'malformed' }
  const expected = signPayload(secret, timestamp, rawBody).split('v1=')[1]
  const a = Buffer.from(provided, 'hex')
  const b = Buffer.from(expected, 'hex')
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, reason: 'bad_signature' }
  // Checked after the MAC so a forger learns nothing about the window.
  if (Math.abs(now / 1000 - timestamp) > toleranceSeconds) return { ok: false, reason: 'replay' }
  return { ok: true, timestamp }
}
