/**
 * GitHub-style webhook signature: `X-Hub-Signature-256: sha256=<hex>`, an
 * HMAC-SHA256 of the raw request bytes. The check runs before the body is parsed,
 * and in constant time so it doesn't leak how much of a guess was right.
 * @module intake/signature
 */
import { createHmac, timingSafeEqual } from 'node:crypto'

export function signBody(secret: string, body: Buffer | string): string {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`
}

export function verifySignature(secret: string, body: Buffer, header: string | undefined): boolean {
  if (!header || !/^sha256=[0-9a-f]{64}$/.test(header)) return false
  const expected = Buffer.from(signBody(secret, body))
  const actual = Buffer.from(header)
  return expected.length === actual.length && timingSafeEqual(expected, actual)
}
