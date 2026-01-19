/**
 * Authentication routes for the admin service.
 * Handles login, logout, and session management.
 * @module admin/auth
 */

import { Router } from 'express'
import type { Request, Response, NextFunction } from 'express'
import { validateLogin, createSession, getSession, deleteSession } from '../shared/auth.js'
import { logger, createChildLogger, logError } from '../shared/logger.js'

const router = Router()

/**
 * Authentication middleware that verifies the admin session cookie.
 * Checks for a valid session ID in cookies and validates it against Redis.
 * On success, attaches session data to req.adminSession for downstream handlers.
 *
 * @description Validates the adminSession cookie and retrieves session data from Redis.
 *   If valid, populates req.adminSession with user info and calls next().
 *   If missing or expired, responds with 401 Unauthorized.
 *
 * @param {Request} req - Express request object with cookies
 * @param {Response} res - Express response object
 * @param {NextFunction} next - Express next function
 * @returns {Promise<void>} Resolves when authentication check completes
 *
 * @throws {Error} May throw if Redis connection fails (handled by error middleware)
 *
 * @example
 * // Use as middleware on protected routes
 * router.get('/protected', requireAdmin, (req, res) => {
 *   res.json({ user: req.adminSession })
 * })
 */
export async function requireAdmin(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  const sessionId = req.cookies.adminSession

  if (!sessionId) {
    res.status(401).json({ error: 'Not authenticated' })
    return
  }

  const session = await getSession(sessionId)
  if (!session) {
    res.status(401).json({ error: 'Session expired' })
    return
  }

  // Attach session to request
  req.adminSession = {
    userId: session.userId,
    email: session.email,
    name: session.name,
  }

  next()
}

/**
 * POST /api/admin/auth/login - Authenticates an admin user.
 *
 * @description Validates email/password credentials against the database.
 *   On success, creates a Redis session and sets an httpOnly cookie.
 *   Supports 'rememberMe' option for extended session duration.
 *
 * @route POST /api/admin/auth/login
 *
 * @param {Request} req - Express request with body containing:
 *   - email {string} - Admin user's email address
 *   - password {string} - Admin user's password
 *   - rememberMe {boolean} [optional] - Extend session duration
 * @param {Response} res - Express response object
 *
 * @returns {object} 200 - User data on successful login
 * @returns {object} 400 - If email or password is missing
 * @returns {object} 401 - If credentials are invalid
 * @returns {object} 500 - If login processing fails
 *
 * @example
 * // Request body
 * { "email": "admin@example.com", "password": "secret123", "rememberMe": true }
 *
 * // Success response
 * { "user": { "id": "uuid", "email": "admin@example.com", "name": "Admin" } }
 */
router.post('/login', async (req: Request, res: Response) => {
  const reqLogger = createChildLogger({ endpoint: '/api/admin/auth/login' })

  try {
    const { email, password, rememberMe } = req.body

    if (!email || !password) {
      res.status(400).json({ error: 'Email and password required' })
      return
    }

    const user = await validateLogin(email, password)
    if (!user) {
      reqLogger.warn({ msg: 'Invalid login attempt', email })
      res.status(401).json({ error: 'Invalid credentials' })
      return
    }

    const { sessionId, ttl } = await createSession(user.id, user.email, user.name, rememberMe)

    res.cookie('adminSession', sessionId, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: ttl * 1000, // Convert seconds to milliseconds
    })

    reqLogger.info({ msg: 'Admin login successful', email })

    res.json({
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
      },
    })
  } catch (error) {
    logError(error as Error, { endpoint: '/api/admin/auth/login' })
    res.status(500).json({ error: 'Login failed' })
  }
})

/**
 * POST /api/admin/auth/logout - Logs out the current admin user.
 *
 * @description Deletes the session from Redis and clears the session cookie.
 *   Works even if no session exists (idempotent).
 *
 * @route POST /api/admin/auth/logout
 *
 * @param {Request} req - Express request with adminSession cookie
 * @param {Response} res - Express response object
 *
 * @returns {object} 200 - Success response { success: true }
 */
router.post('/logout', async (req: Request, res: Response) => {
  const sessionId = req.cookies.adminSession

  if (sessionId) {
    await deleteSession(sessionId)
    logger.info({ msg: 'Admin logout', sessionId: sessionId.substring(0, 8) + '...' })
  }

  res.clearCookie('adminSession')
  res.json({ success: true })
})

/**
 * GET /api/admin/auth/me - Returns the current authenticated user.
 *
 * @description Protected endpoint that returns the session data for the
 *   currently authenticated admin user. Requires valid session cookie.
 *
 * @route GET /api/admin/auth/me
 *
 * @param {Request} req - Express request (must pass requireAdmin middleware)
 * @param {Response} res - Express response object
 *
 * @returns {object} 200 - User session data { user: AdminSession }
 * @returns {object} 401 - If not authenticated (via requireAdmin)
 *
 * @example
 * // Success response
 * { "user": { "userId": "uuid", "email": "admin@example.com", "name": "Admin" } }
 */
router.get('/me', requireAdmin, (req: Request, res: Response) => {
  res.json({ user: req.adminSession })
})

export { router as authRouter }
