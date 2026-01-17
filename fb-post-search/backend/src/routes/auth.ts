import { Router } from 'express';
import * as authController from '../controllers/authController.js';
import { requireAuth } from '../middleware/auth.js';

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
