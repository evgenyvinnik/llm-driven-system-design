/**
 * Admin routes for the job scheduler API.
 * Handles user management, cleanup, storage stats, and circuit breaker control.
 * @module api/admin-routes
 */

import { Router, Request, Response } from 'express';
import { asyncHandler } from './types';
import {
  authenticate,
  authorize,
  createSession,
  destroySession,
  validateCredentials,
  createUser,
} from '../shared/auth';
import { resetAllCircuitBreakers } from '../shared/circuit-breaker';
import { runCleanup, getCleanupPreview, getStorageStats, retentionConfig } from '../shared/archival';

const router = Router();

// === Authentication Endpoints ===

/**
 * POST /api/auth/login - Authenticate user and create session.
 *
 * @description Validates user credentials and creates a new session. On success,
 * sets an HTTP-only session cookie and returns user information. The session
 * expires after 24 hours.
 *
 * @route POST /api/auth/login
 * @access Public
 *
 * @param {Object} req.body - Login credentials
 * @param {string} req.body.username - User's username
 * @param {string} req.body.password - User's password
 *
 * @returns {ApiResponse<{user: User}>} 200 - Login successful with user data
 * @returns {ApiResponse} 400 - Missing username or password
 * @returns {ApiResponse} 401 - Invalid credentials
 *
 * @example
 * ```bash
 * curl -X POST /api/auth/login \
 *   -H "Content-Type: application/json" \
 *   -d '{"username": "admin", "password": "secret"}'
 * ```
 */
router.post(
  '/auth/login',
  asyncHandler(async (req, res) => {
    const { username, password } = req.body;

    if (!username || !password) {
      res.status(400).json({
        success: false,
        error: 'Username and password are required',
      });
      return;
    }

    const user = await validateCredentials(username, password);

    if (!user) {
      res.status(401).json({
        success: false,
        error: 'Invalid credentials',
      });
      return;
    }

    const sessionId = await createSession(user);

    res.cookie('session_id', sessionId, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: 86400000, // 24 hours
    });

    res.json({
      success: true,
      data: { user: { id: user.id, username: user.username, role: user.role } },
      message: 'Login successful',
    });
  })
);

/**
 * POST /api/auth/logout - Destroy current session and log out.
 *
 * @description Destroys the user's current session and clears the session cookie.
 * Requires authentication.
 *
 * @route POST /api/auth/logout
 * @access Authenticated users
 *
 * @returns {ApiResponse} 200 - Logout successful
 *
 * @example
 * ```bash
 * curl -X POST /api/auth/logout -b 'session_id=abc123'
 * ```
 */
router.post(
  '/auth/logout',
  authenticate,
  asyncHandler(async (req, res) => {
    if (req.sessionId) {
      await destroySession(req.sessionId);
    }

    res.clearCookie('session_id');
    res.json({
      success: true,
      message: 'Logout successful',
    });
  })
);

/**
 * GET /api/auth/me - Get current authenticated user.
 *
 * @description Returns the currently authenticated user's information including
 * their ID, username, and role. Requires authentication.
 *
 * @route GET /api/auth/me
 * @access Authenticated users
 *
 * @returns {ApiResponse<{id: string, username: string, role: string}>} 200 - Current user info
 *
 * @example
 * ```bash
 * curl -X GET /api/auth/me -b 'session_id=abc123'
 * ```
 */
router.get('/auth/me', authenticate, (req: Request, res: Response) => {
  res.json({
    success: true,
    data: {
      id: req.user?.userId,
      username: req.user?.username,
      role: req.user?.role,
    },
  });
});

// === Admin User Management ===

/**
 * POST /api/v1/admin/users - Create a new user.
 *
 * @description Creates a new user account with the specified username, password,
 * and role. Default role is 'user' if not specified. Requires admin authorization.
 *
 * @route POST /api/v1/admin/users
 * @access Admin only
 *
 * @param {Object} req.body - User creation parameters
 * @param {string} req.body.username - Username for the new account
 * @param {string} req.body.password - Password for the new account
 * @param {string} [req.body.role='user'] - Role assignment ('admin' or 'user')
 *
 * @returns {ApiResponse<User>} 201 - Created user object (password excluded)
 * @returns {ApiResponse} 400 - Missing required fields
 *
 * @throws {Error} If username already exists
 *
 * @example
 * ```bash
 * curl -X POST /api/v1/admin/users \
 *   -d '{"username": "newuser", "password": "secure123", "role": "user"}'
 * ```
 */
router.post(
  '/v1/admin/users',
  authenticate,
  authorize('admin'),
  asyncHandler(async (req, res) => {
    const { username, password, role } = req.body;

    if (!username || !password) {
      res.status(400).json({
        success: false,
        error: 'Username and password are required',
      });
      return;
    }

    const user = await createUser(username, password, role || 'user');

    res.status(201).json({
      success: true,
      data: user,
      message: 'User created successfully',
    });
  })
);

// === Admin System Management ===

/**
 * POST /api/v1/admin/cleanup - Run data cleanup or preview cleanup.
 *
 * @description Runs the data retention cleanup process to delete old executions and logs
 * based on configured retention policies. When dryRun is true, returns a preview of what
 * would be deleted without actually deleting anything. Requires admin authorization.
 *
 * @route POST /api/v1/admin/cleanup
 * @access Admin only
 *
 * @param {Object} req.body - Cleanup options
 * @param {boolean} [req.body.dryRun=false] - If true, preview changes without executing
 *
 * @returns {ApiResponse<CleanupStats>} 200 - Cleanup statistics (or preview)
 *
 * @example
 * ```bash
 * # Preview cleanup
 * curl -X POST /api/v1/admin/cleanup -d '{"dryRun": true}'
 *
 * # Execute cleanup
 * curl -X POST /api/v1/admin/cleanup -d '{"dryRun": false}'
 * ```
 */
router.post(
  '/v1/admin/cleanup',
  authenticate,
  authorize('admin'),
  asyncHandler(async (req, res) => {
    const { dryRun } = req.body;

    if (dryRun) {
      const preview = await getCleanupPreview();
      res.json({
        success: true,
        data: preview,
        message: 'Cleanup preview (dry run)',
      });
      return;
    }

    const stats = await runCleanup();

    res.json({
      success: true,
      data: stats,
      message: 'Cleanup completed successfully',
    });
  })
);

/**
 * GET /api/v1/admin/storage - Get storage statistics.
 *
 * @description Returns database storage statistics including table sizes, row counts,
 * and the current retention configuration. Useful for monitoring storage growth and
 * planning cleanup operations. Requires admin authorization.
 *
 * @route GET /api/v1/admin/storage
 * @access Admin only
 *
 * @returns {ApiResponse<{stats: StorageStats, retentionConfig: RetentionConfig}>} 200 - Storage statistics
 *
 * @example
 * ```bash
 * curl -X GET /api/v1/admin/storage
 * # Response: {"success":true,"data":{"stats":{...},"retentionConfig":{...}}}
 * ```
 */
router.get(
  '/v1/admin/storage',
  authenticate,
  authorize('admin'),
  asyncHandler(async (_req, res) => {
    const stats = await getStorageStats();

    res.json({
      success: true,
      data: {
        stats,
        retentionConfig,
      },
    });
  })
);

/**
 * POST /api/v1/admin/circuit-breakers/reset - Reset all circuit breakers.
 *
 * @description Resets all circuit breakers to their closed (normal) state. Use this
 * after resolving the underlying issues that caused circuit breakers to open.
 * Requires admin authorization.
 *
 * @route POST /api/v1/admin/circuit-breakers/reset
 * @access Admin only
 *
 * @returns {ApiResponse} 200 - Circuit breakers reset confirmation
 *
 * @example
 * ```bash
 * curl -X POST /api/v1/admin/circuit-breakers/reset
 * # Response: {"success":true,"message":"All circuit breakers reset"}
 * ```
 */
router.post(
  '/v1/admin/circuit-breakers/reset',
  authenticate,
  authorize('admin'),
  asyncHandler(async (_req, res) => {
    resetAllCircuitBreakers();

    res.json({
      success: true,
      message: 'All circuit breakers reset',
    });
  })
);

export { router as adminRoutes };
