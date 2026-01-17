/**
 * Simple session-based authentication middleware
 * @module shared/auth
 */
import type { Request, Response, NextFunction } from 'express'
import { redis } from './cache.js'

declare global {
  namespace Express {
    interface Request {
      userId?: string
      sessionId?: string
    }
  }
}

/**
 * Authentication middleware - validates session token
 */
export async function authMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  const authHeader = req.headers.authorization
  if (!authHeader?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Missing authorization header' })
    return
  }

  const sessionId = authHeader.slice(7)
  const session = await redis.get(`session:${sessionId}`)

  if (!session) {
    res.status(401).json({ error: 'Invalid or expired session' })
    return
  }

  const { userId } = JSON.parse(session)
  req.userId = userId
  req.sessionId = sessionId

  next()
}

/**
 * Optional auth middleware - doesn't require authentication but extracts user if present
 */
export async function optionalAuthMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  const authHeader = req.headers.authorization
  if (authHeader?.startsWith('Bearer ')) {
    const sessionId = authHeader.slice(7)
    const session = await redis.get(`session:${sessionId}`)
    if (session) {
      const { userId } = JSON.parse(session)
      req.userId = userId
      req.sessionId = sessionId
    }
  }
  next()
}

/**
 * Create a new session for a user
 * @param userId - User ID
 * @returns Session ID
 */
export async function createSession(userId: string): Promise<string> {
  const sessionId = crypto.randomUUID()
  await redis.setEx(
    `session:${sessionId}`,
    86400 * 7, // 7 days
    JSON.stringify({ userId, createdAt: Date.now() })
  )
  return sessionId
}

/**
 * Destroy a session
 * @param sessionId - Session ID to destroy
 */
export async function destroySession(sessionId: string): Promise<void> {
  await redis.del(`session:${sessionId}`)
}
