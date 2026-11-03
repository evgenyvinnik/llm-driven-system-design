/**
 * On-behalf-of tokens. The orchestrator mints one per turn, and the tool
 * service derives the acting user from it, never from tool arguments. A tool
 * call therefore can't read or change anything the user couldn't, whatever
 * the model asks for.
 *
 * A real deployment exchanges the user's session for a short-lived OAuth token
 * scoped to the assistant; an HMAC-signed payload stands in for that here.
 * @module shared/obo
 */
import { createHmac, timingSafeEqual } from 'node:crypto'
import { config } from './config.js'

export interface OboClaims {
  sub: string
  org: string
  email: string
  tz: string
  turn: string
  scopes: string[]
  exp: number
}

function sign(payload: string): string {
  return createHmac('sha256', config.oboSecret).update(payload).digest('base64url')
}

export function mintOboToken(claims: Omit<OboClaims, 'exp'>, ttlSeconds = 900): string {
  const payload = Buffer.from(JSON.stringify({ ...claims, exp: Math.floor(Date.now() / 1000) + ttlSeconds })).toString(
    'base64url',
  )
  return `${payload}.${sign(payload)}`
}

export function verifyOboToken(token: string): OboClaims {
  const [payload, signature] = token.split('.')
  if (!payload || !signature) throw new Error('Malformed on-behalf-of token')
  const expected = Buffer.from(sign(payload))
  const actual = Buffer.from(signature)
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    throw new Error('Invalid on-behalf-of token signature')
  }
  const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as OboClaims
  if (claims.exp < Math.floor(Date.now() / 1000)) throw new Error('On-behalf-of token expired')
  return claims
}
