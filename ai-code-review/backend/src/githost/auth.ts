/**
 * Token scopes at the host. The worker's token can only read, and that is
 * enforced here rather than by convention in the worker's code: even a fully
 * subverted worker cannot post an approval.
 * @module githost/auth
 */
import type { NextFunction, Request, Response } from 'express'

export type Scope = 'read' | 'reviews:write' | 'admin'

interface Credential {
  identity: string
  scopes: Scope[]
}

const READER = process.env.GITHOST_READER_TOKEN || 'dev-reader-token'
const POSTER = process.env.GITHOST_POSTER_TOKEN || 'dev-poster-token'
const ADMIN = process.env.GITHOST_ADMIN_TOKEN || 'dev-fixture-admin-token'

const CREDENTIALS = new Map<string, Credential>([
  [READER, { identity: 'review-reader', scopes: ['read'] }],
  [POSTER, { identity: process.env.BOT_LOGIN || 'review-bot', scopes: ['read', 'reviews:write'] }],
  [ADMIN, { identity: 'fixture-admin', scopes: ['read', 'admin'] }],
])

declare module 'express-serve-static-core' {
  interface Request {
    hostIdentity?: string
  }
}

export function requireScope(scope: Scope) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const token = req.headers.authorization?.replace(/^Bearer\s+/i, '') ?? ''
    const credential = CREDENTIALS.get(token)
    if (!credential) {
      res.status(401).json({ error: { code: 'BAD_CREDENTIALS', message: 'Unknown token' } })
      return
    }
    if (!credential.scopes.includes(scope)) {
      res.status(403).json({ error: { code: 'INSUFFICIENT_SCOPE', message: `This token cannot ${scope}` } })
      return
    }
    req.hostIdentity = credential.identity
    next()
  }
}
