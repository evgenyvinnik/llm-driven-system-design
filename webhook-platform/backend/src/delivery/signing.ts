/**
 * Request signing and verification.
 *
 * Header: `Webhook-Signature: t=<unix seconds>,v1=<hex>[,v1=<hex>]`
 * Each v1 is HMAC-SHA256(secret, `${t}.${rawBody}`), hex encoded.
 *
 * - The timestamp is inside the signed bytes, so an attacker who captured a
 *   request can't re-send it later with a fresh timestamp. Receivers reject
 *   timestamps outside a tolerance window (default 5 minutes): that bounds
 *   replay of a captured request to the window, and event-id dedupe covers
 *   the rest.
 * - During a secret rotation the platform signs with BOTH the new and the
 *   previous secret, so a receiver that still has only the old secret keeps
 *   verifying until the overlap ends, and one that already has the new
 *   secret verifies immediately. Nobody has to deploy at the same instant.
 * - The secret string itself is the HMAC key (UTF-8). The `whsec_` prefix is
 *   part of it, which keeps the customer snippet a one-liner.
 * @module delivery/signing
 */
import { createHmac, timingSafeEqual } from 'node:crypto'

export const SIGNATURE_HEADER = 'webhook-signature'

export interface EndpointSecrets {
  secretCurrent: string
  secretPrevious: string | null
  previousExpiresAt: Date | null
}

/** Secrets the platform signs with right now: the current one, plus the previous one while its overlap lasts. */
export function activeSigningSecrets(e: EndpointSecrets, now: Date = new Date()): string[] {
  const out = [e.secretCurrent]
  if (e.secretPrevious && e.previousExpiresAt && e.previousExpiresAt.getTime() > now.getTime()) out.push(e.secretPrevious)
  return out
}

export function computeSignature(secret: string, timestamp: number, body: string): string {
  return createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')
}

export function signatureHeader(secrets: string[], timestamp: number, body: string): string {
  return [`t=${timestamp}`, ...secrets.map((s) => `v1=${computeSignature(s, timestamp, body)}`)].join(',')
}

export interface ParsedSignature {
  timestamp: number
  signatures: string[]
}

export function parseSignatureHeader(header: string | undefined | null): ParsedSignature | null {
  if (!header) return null
  let timestamp: number | null = null
  const signatures: string[] = []
  for (const part of header.split(',')) {
    const idx = part.indexOf('=')
    if (idx <= 0) continue
    const key = part.slice(0, idx).trim()
    const value = part.slice(idx + 1).trim()
    if (key === 't' && /^\d{1,12}$/.test(value)) timestamp = Number(value)
    else if (key === 'v1' && /^[0-9a-f]{64}$/.test(value)) signatures.push(value)
  }
  if (timestamp === null || signatures.length === 0) return null
  return { timestamp, signatures }
}

export type VerifyResult =
  | { ok: true; matchedSecretIndex: number; timestamp: number }
  | { ok: false; reason: 'missing_header' | 'malformed_header' | 'timestamp_outside_tolerance' | 'no_matching_signature' }

/**
 * Receiver-side check. `secrets` are the ones this receiver knows about
 * (typically one; two while it is mid-rotation).
 */
export function verifySignature(
  header: string | undefined | null,
  rawBody: string,
  secrets: string[],
  opts: { toleranceSeconds?: number; nowSeconds?: number } = {},
): VerifyResult {
  if (!header) return { ok: false, reason: 'missing_header' }
  const parsed = parseSignatureHeader(header)
  if (!parsed) return { ok: false, reason: 'malformed_header' }
  const now = opts.nowSeconds ?? Math.floor(Date.now() / 1000)
  const tolerance = opts.toleranceSeconds ?? 300
  if (Math.abs(now - parsed.timestamp) > tolerance) return { ok: false, reason: 'timestamp_outside_tolerance' }
  for (let i = 0; i < secrets.length; i++) {
    const expected = Buffer.from(computeSignature(secrets[i], parsed.timestamp, rawBody), 'hex')
    for (const sig of parsed.signatures) {
      const got = Buffer.from(sig, 'hex')
      if (got.length === expected.length && timingSafeEqual(got, expected)) return { ok: true, matchedSecretIndex: i, timestamp: parsed.timestamp }
    }
  }
  return { ok: false, reason: 'no_matching_signature' }
}
