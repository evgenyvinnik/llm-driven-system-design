/**
 * @fileoverview Authentication API routes.
 * Defines endpoints for login, registration, logout, and current user.
 */

import { Router } from 'express';
import * as authController from '../controllers/authController.js';
import { requireAuth } from '../middleware/auth.js';

/**
 * Express router for authentication-related endpoints.
 * Base path: /api/v1/auth
 */
const router = Router();

// POST /api/v1/auth/login
router.post('/login', authController.login);

// POST /api/v1/auth/register
router.post('/register', authController.register);

// POST /api/v1/auth/logout
router.post('/logout', authController.logout);

// GET /api/v1/auth/me - Get current user
router.get('/me', requireAuth, authController.getCurrentUser);

export default router;
