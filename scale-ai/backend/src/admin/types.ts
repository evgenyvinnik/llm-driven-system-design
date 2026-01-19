/**
 * Shared types and interfaces for the admin service.
 * @module admin/types
 */

import type { Request, Response, NextFunction } from 'express'

/**
 * Session data attached to authenticated requests.
 * Contains user information extracted from the session cookie.
 *
 * @interface AdminSession
 * @property {string} userId - Unique identifier of the authenticated admin user
 * @property {string} email - Email address of the admin user
 * @property {string | null} name - Display name of the admin user, or null if not set
 *
 * @example
 * const session: AdminSession = {
 *   userId: '123e4567-e89b-12d3-a456-426614174000',
 *   email: 'admin@example.com',
 *   name: 'John Doe',
 * }
 */
export interface AdminSession {
  userId: string
  email: string
  name: string | null
}

/**
 * Express request extended with admin session data.
 * Used by route handlers that require authentication.
 *
 * @interface AdminRequest
 * @extends {Request}
 * @property {AdminSession} [adminSession] - Session data attached by the requireAdmin middleware
 *
 * @example
 * router.get('/protected', requireAdmin, (req: AdminRequest, res: Response) => {
 *   const { userId, email } = req.adminSession!
 *   res.json({ userId, email })
 * })
 */
export interface AdminRequest extends Request {
  adminSession?: AdminSession
}

/**
 * Express route handler type for admin routes.
 * Accepts an AdminRequest with session data and can be async.
 *
 * @typedef {Function} AdminHandler
 * @param {AdminRequest} req - Express request with admin session attached
 * @param {Response} res - Express response object
 * @param {NextFunction} next - Express next function for error handling
 * @returns {void | Promise<void>} May return a Promise for async handlers
 */
export type AdminHandler = (
  req: AdminRequest,
  res: Response,
  next: NextFunction
) => void | Promise<void>

// Extend Express Request type globally
declare global {
  namespace Express {
    interface Request {
      adminSession?: AdminSession
    }
  }
}
